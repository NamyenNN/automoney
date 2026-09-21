```javascript
/**
 * KMITL Class Payment System - Core Application Logic
 * Feature List:
 * - Google Sign-In with @kmitl.ac.th validation
 * - Persistent session (remember login)
 * - Persistent Fee Items in LocalStorage
 * - Persistent Settings (Google Script Web App URL & PromptPay info)
 * - Dynamic PromptPay QR Code generator
 * - Slip upload & Client-side QR Reader (jsQR)
 * - Google Sheet & Google Drive integration via Apps Script
 * - Admin Treasurer View & Student Dashboard
 * - Payment history synced from Google Sheet
 * - Current payment status based on latest submission
 */

// ==========================================
// DEFAULT FEE ITEMS
// ==========================================
const DEFAULT_FEE_ITEMS = [
  {
    id: 'fee-101',
    category: 'ค่าห้องประจำเดือน',
    name: 'ค่ากองกลางห้องเรียน ประจำเดือน ก.ค. 2569',
    description: 'สำหรับค่าอุปกรณ์ทำความสะอาดห้อง ค่าชีทส่วนกลาง และสวัสดิการห้อง',
    amount: 100,
    dueDate: '2026-07-31'
  },
  {
    id: 'fee-102',
    category: 'ค่าเสื้อช็อป & ป้ายชื่อ',
    name: 'ค่าเสื้อช็อปภาควิชา + ป้ายชื่อสแกน',
    description: 'สำหรับนักศึกษาชั้นปีที่ 1 และผู้ที่สั่งเพิ่ม ชำระก่อนสั่งตัดล็อตแรก',
    amount: 450,
    dueDate: '2026-08-15'
  },
  {
    id: 'fee-103',
    category: 'ค่าเอกสารการเรียน',
    name: 'ค่าชีทสรุปเตรียมสอบ Midterm วิชา Core Math',
    description: 'รวมค่าจัดพิมพ์ชีทเข้าเล่ม 120 หน้า',
    amount: 80,
    dueDate: '2026-08-05'
  }
];

// ==========================================
// CONFIGURATION
// ==========================================
let CONFIG = JSON.parse(
  localStorage.getItem('kmitl_pay_config')
) || {};

if (!CONFIG.GOOGLE_SCRIPT_URL) {
  CONFIG.GOOGLE_SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbw_OxjIFz_N6wJzF_fFhoJE6P561_jBoWMs8WDO9q8b1RsnYdaDtormoQnupF1oHQ8J/exec';
}

CONFIG.LINE_CHANNEL_ID =
  CONFIG.LINE_CHANNEL_ID || '2010801650';

/*
 * IMPORTANT:
 * อย่าใส่ LINE Channel Secret จริงไว้ใน GitHub Pages
 * ถ้ามีค่าเก่าอยู่ใน localStorage ระบบยังสามารถใช้งานได้
 * ถ้าไม่มี ให้ตั้งค่าผ่านหน้า Configuration
 */
CONFIG.LINE_CHANNEL_SECRET =
  CONFIG.LINE_CHANNEL_SECRET || '';

CONFIG.LIFF_ID =
  CONFIG.LIFF_ID || '2010801650-te43AoZe';

if (!CONFIG.PROMPTPAY_NUMBER) {
  CONFIG.PROMPTPAY_NUMBER = '0891234567';
}

if (!CONFIG.PROMPTPAY_NAME) {
  CONFIG.PROMPTPAY_NAME =
    'เหรัญญิกประจำห้อง (KMITL Pay)';
}

if (CONFIG.ALLOW_NON_KMITL_IN_DEMO === undefined) {
  CONFIG.ALLOW_NON_KMITL_IN_DEMO = false;
}

localStorage.setItem(
  'kmitl_pay_config',
  JSON.stringify(CONFIG)
);

// ==========================================
// INITIAL STATE
// ==========================================
let currentUser = null;
let currentView = 'student';

let selectedFeeItem = null;

let currentSlipBase64 = null;
let currentSlipQRData = null;

let currentPaymentQty = 1;

// Fee items
let feeItems =
  JSON.parse(
    localStorage.getItem('kmitl_pay_fee_items')
  ) || DEFAULT_FEE_ITEMS;

// Payment submissions
let submissions =
  JSON.parse(
    localStorage.getItem('kmitl_pay_submissions')
  ) || [];

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {

  setupDragAndDrop();
  checkGasConfigAlert();

  // Load data from Google Sheet
  fetchSubmissionsFromGas();
  fetchFeeItemsFromGas();

  // Load system configuration
  fetchSystemConfigFromGas();

  // Admin page
  if (
    window.location.pathname
      .toLowerCase()
      .includes('admin.html')
  ) {
    currentView = 'admin';
    renderAdminDashboard();
    return;
  }

  /*
   * IMPORTANT:
   * Check saved session first.
   * This makes "Remember Login" work immediately.
   */
  const hasSavedSession = checkSavedSession();

  /*
   * If there is no saved session,
   * try LIFF auto login.
   */
  if (!hasSavedSession) {
    await checkLiffAutoLogin();
  }

  checkLineAuthCode();
});

// ==========================================
// STATUS NORMALIZER
// ==========================================
function normalizeStatus(st) {

  if (!st) {
    return 'Pending';
  }

  const str =
    st.toString()
      .trim()
      .toLowerCase();

  if (
    str.includes('approved') ||
    str.includes('อนุมัติ') ||
    str.includes('ชำระแล้ว') ||
    str.includes('paid')
  ) {
    return 'Approved';
  }

  if (
    str.includes('reject') ||
    str.includes('ปฏิเสธ') ||
    str.includes('ไม่อนุมัติ')
  ) {
    return 'Rejected';
  }

  return 'Pending';
}

// ==========================================
// NORMALIZE STUDENT ID
// ==========================================
function normalizeStudentId(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return value
    .toString()
    .trim();
}

// ==========================================
// GET SUBMISSION ROW NUMBER
// ==========================================
function getSubmissionRowNumber(sub, fallbackIndex = 0) {

  if (
    sub &&
    sub.rowNumber &&
    Number.isFinite(Number(sub.rowNumber))
  ) {
    return Number(sub.rowNumber);
  }

  /*
   * Google Sheet:
   * Row 1 = Header
   * Therefore array index 0 = Sheet row 2
   */
  return fallbackIndex + 2;
}

// ==========================================
// PARSE DATE SAFELY
// ==========================================
function getSubmissionTime(sub) {

  if (!sub) {
    return 0;
  }

  /*
   * Prefer numeric timestamp if backend sends one.
   */
  if (
    sub.timestampValue !== undefined &&
    sub.timestampValue !== null
  ) {
    const numeric =
      Number(sub.timestampValue);

    if (
      Number.isFinite(numeric) &&
      numeric > 0
    ) {
      return numeric;
    }
  }

  const raw =
    sub.timestamp
      ? sub.timestamp.toString().trim()
      : '';

  if (!raw) {
    return 0;
  }

  const parsed =
    new Date(raw).getTime();

  if (
    Number.isFinite(parsed) &&
    parsed > 0
  ) {
    return parsed;
  }

  /*
   * Try Thai date formats such as:
   * 21/9/2569 16:00:00
   */
  const match =
    raw.match(
      /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
    );

  if (match) {

    let year = Number(match[3]);

    /*
     * Buddhist year -> Gregorian
     */
    if (year > 2400) {
      year -= 543;
    }

    const month =
      Number(match[2]) - 1;

    const day =
      Number(match[1]);

    const hour =
      Number(match[4] || 0);

    const minute =
      Number(match[5] || 0);

    const second =
      Number(match[6] || 0);

    const d =
      new Date(
        year,
        month,
        day,
        hour,
        minute,
        second
      );

    const time =
      d.getTime();

    if (
      Number.isFinite(time) &&
      time > 0
    ) {
      return time;
    }
  }

  return 0;
}

// ==========================================
// FETCH PAYMENT SUBMISSIONS FROM GOOGLE SHEET
// ==========================================
async function fetchSubmissionsFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    return;
  }

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (
        CONFIG.GOOGLE_SCRIPT_URL.includes('?')
          ? '&'
          : '?'
      ) +
      'action=getPayments&t=' +
      Date.now();

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success' &&
      Array.isArray(result.data)
    ) {

      const sheetSubmissions =
        result.data.map((row, idx) => {

          /*
           * IMPORTANT:
           * ใช้ชื่อคอลัมน์จริงจาก Sheet ก่อน
           */
          const studentId =
            row['Student ID'] ||
            row['รหัสนักศึกษา'] ||
            row['ข้อมูลประจำตัว/รหัส'] ||
            '';

          const amount =
            parseFloat(
              row['จำนวนเงิน'] ||
              row['จำนวนเงิน (บาท)'] ||
              0
            ) || 0;

          const slipUrl =
            row['ลิงก์สลิป'] ||
            row['ลิงก์สลิปใน Google Drive'] ||
            '';

          const qrRef =
            row['QR Ref'] ||
            row['ข้อมูล QR Ref บนสลิป'] ||
            '';

          const rawTimestamp =
            row['วันเวลาที่ส่ง'] !== undefined &&
            row['วันเวลาที่ส่ง'] !== null
              ? row['วันเวลาที่ส่ง'].toString()
              : '';

          /*
           * Some Apps Script versions may return
           * an ISO timestamp field.
           */
          const timestampValue =
            row['timestampValue'] ||
            row['_timestamp'] ||
            row['Timestamp'] ||
            '';

          return {

            id: 'gas-' + idx,

            /*
             * Sheet row number
             */
            rowNumber:
              Number(row['rowNumber']) ||
              Number(row['_rowNumber']) ||
              idx + 2,

            timestamp:
              rawTimestamp,

            timestampValue:
              timestampValue,

            studentName:
              row['ชื่อ-นามสกุล']
                ? row['ชื่อ-นามสกุล'].toString()
                : '',

            /*
             * THIS IS THE IMPORTANT FIX
             */
            studentId:
              normalizeStudentId(studentId),

            /*
             * Keep old property compatibility
             */
            studentEmail:
              normalizeStudentId(studentId),

            feeName:
              row['รายการชำระเงิน']
                ? row['รายการชำระเงิน'].toString()
                : '',

            amount:
              amount,

            status:
              normalizeStatus(
                row['สถานะ']
              ),

            slipUrl:
              slipUrl.toString(),

            qrRef:
              qrRef.toString(),

            remark:
              row['หมายเหตุ']
                ? row['หมายเหตุ'].toString()
                : ''
          };
        });

      /*
       * Replace local cache with the
       * latest Google Sheet data.
       *
       * This does NOT delete history from Sheet.
       */
      submissions =
        sheetSubmissions;

      localStorage.setItem(
        'kmitl_pay_submissions',
        JSON.stringify(submissions)
      );

      console.log(
        '[GAS] Loaded submissions:',
        submissions.length
      );

      if (currentUser) {

        renderStudentDashboard();
        renderStudentHistoryTable();

      }

      if (currentView === 'admin') {
        renderAdminDashboard();
      }
    }

  } catch (err) {

    console.warn(
      '[GAS] Fetch submissions error:',
      err
    );
  }
}

// ==========================================
// FETCH FEE ITEMS FROM GOOGLE SHEET
// ==========================================
async function fetchFeeItemsFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    return;
  }

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (
        CONFIG.GOOGLE_SCRIPT_URL.includes('?')
          ? '&'
          : '?'
      ) +
      'action=getFeeItems&t=' +
      Date.now();

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success' &&
      Array.isArray(result.data)
    ) {

      const cloudItems =
        result.data.map(item => {

          let cleanDueDate =
            item.dueDate
              ? item.dueDate.toString()
              : '';

          if (
            cleanDueDate.includes('GMT') ||
            cleanDueDate.includes('T')
          ) {

            try {

              const d =
                new Date(cleanDueDate);

              cleanDueDate =
                d.toISOString()
                  .split('T')[0];

            } catch (e) {}
          }

          return {

            id:
              item.id ||
              ('fee-' + Date.now()),

            category:
              item.category ||
              'ค่าห้อง',

            name:
              item.name ||
              '',

            description:
              item.description ||
              '',

            amount:
              parseFloat(item.amount) ||
              0,

            dueDate:
              cleanDueDate
          };
        });

      /*
       * Cloud data becomes source of truth
       */
      feeItems =
        cloudItems;

      saveFeeItemsToStorage();

      if (currentUser) {
        renderStudentDashboard();
      }

      renderAdminDashboard();
    }

  } catch (err) {

    console.warn(
      'Fetch fee items error:',
      err
    );
  }
}

// ==========================================
// LIFF AUTO LOGIN
// ==========================================
async function checkLiffAutoLogin() {

  if (
    CONFIG.LIFF_ID &&
    typeof liff !== 'undefined'
  ) {

    try {

      await liff.init({
        liffId: CONFIG.LIFF_ID
      });

      if (liff.isLoggedIn()) {

        const profile =
          await liff.getProfile();

        await processLiffProfile(profile);

        return true;
      }

    } catch (err) {

      console.warn(
        'LIFF Auto-login check:',
        err
      );
    }
  }

  return false;
}

// ==========================================
// GOOGLE SIGN-IN
// ==========================================
function initGoogleSignIn() {

  const btnContainer =
    document.getElementById(
      'g_id_signin_dynamic'
    );

  const noteEl =
    document.getElementById(
      'googleSignInNote'
    );

  if (!btnContainer) {
    return;
  }

  btnContainer.innerHTML = '';

  if (!CONFIG.GOOGLE_CLIENT_ID) {

    if (noteEl) {
      noteEl.style.display = 'block';
    }

    return;
  }

  if (noteEl) {
    noteEl.style.display = 'none';
  }

  setTimeout(() => {

    if (
      typeof google !== 'undefined'
    ) {

      try {

        google.accounts.id.initialize({

          client_id:
            CONFIG.GOOGLE_CLIENT_ID,

          callback:
            handleGoogleSignIn,

          context:
            'signin',

          ux_mode:
            'popup',

          auto_select:
            false,

          itp_support:
            true

        });

        google.accounts.id.renderButton(
          btnContainer,
          {
            type: 'standard',
            shape: 'rectangular',
            theme: 'filled_blue',
            text: 'signin_with',
            size: 'large',
            logo_alignment: 'left'
          }
        );

      } catch (err) {

        console.error(
          'Google Sign-in rendering error:',
          err
        );
      }
    }

  }, 500);
}

// ==========================================
// STORAGE
// ==========================================
function saveFeeItemsToStorage() {

  localStorage.setItem(
    'kmitl_pay_fee_items',
    JSON.stringify(feeItems)
  );
}

function saveConfigToStorage() {

  localStorage.setItem(
    'kmitl_pay_config',
    JSON.stringify(CONFIG)
  );

  checkGasConfigAlert();
}

// ==========================================
// GAS CONFIG ALERT
// ==========================================
function checkGasConfigAlert() {

  const alertBox =
    document.getElementById(
      'gasStatusAlert'
    );

  if (!alertBox) {
    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    alertBox.style.display = 'block';

    alertBox.innerHTML = `
      <div style="
        background: rgba(245, 158, 11, 0.15);
        border: 1px solid rgba(245, 158, 11, 0.4);
        color: var(--color-warning);
        padding: 12px 16px;
        border-radius: 12px;
        font-size: 0.875rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div>
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>ยังไม่ได้ระบุ Google Apps Script Web App URL:</strong>
          ระบบกำลังทำงานในโหมดสาธิต
        </div>

        <button
          class="btn btn-secondary btn-sm"
          onclick="openConfigModal()"
        >
          ตั้งค่าตอนนี้
        </button>
      </div>
    `;

  } else {

    alertBox.style.display = 'block';

    alertBox.innerHTML = `
      <div style="
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid rgba(16, 185, 129, 0.4);
        color: var(--color-success);
        padding: 12px 16px;
        border-radius: 12px;
        font-size: 0.875rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div>
          <i class="fa-solid fa-circle-check"></i>
          <strong>เชื่อมต่อ Google Apps Script เรียบร้อย:</strong>
          ข้อมูลสลิปและประวัติจะถูกส่งตรงเข้า Google Sheet & Google Drive
        </div>

        <button
          class="btn btn-secondary btn-sm"
          onclick="openConfigModal()"
        >
          แก้ไขตั้งค่า
        </button>
      </div>
    `;
  }
}

// ==========================================
// REMEMBER LOGIN
// ==========================================
function checkSavedSession() {

  const savedUser =
    localStorage.getItem(
      'kmitl_pay_user'
    );

  if (savedUser) {

    try {

      const parsed =
        JSON.parse(savedUser);

      /*
       * Require Student ID
       */
      if (
        !parsed ||
        !parsed.studentId
      ) {

        localStorage.removeItem(
          'kmitl_pay_user'
        );

      } else {

        currentUser =
          parsed;

        showMainApplication(
          currentUser
        );

        console.log(
          '[SESSION] Restored:',
          currentUser.studentId
        );

        return true;
      }

    } catch (e) {

      console.warn(
        '[SESSION] Invalid saved session:',
        e
      );

      localStorage.removeItem(
        'kmitl_pay_user'
      );
    }
  }

  /*
   * Show login screen
   */
  const loginSection =
    document.getElementById(
      'loginSection'
    );

  const registerSection =
    document.getElementById(
      'registerSection'
    );

  const mainAppSection =
    document.getElementById(
      'mainAppSection'
    );

  const navControls =
    document.getElementById(
      'navControls'
    );

  if (loginSection) {
    loginSection.style.display = 'block';
  }

  if (registerSection) {
    registerSection.style.display = 'none';
  }

  if (mainAppSection) {
    mainAppSection.style.display = 'none';
  }

  if (navControls) {
    navControls.style.display = 'none';
  }

  return false;
}

// ==========================================
// LINE AUTH CODE
// ==========================================
function checkLineAuthCode() {

  const urlParams =
    new URLSearchParams(
      window.location.search
    );

  const code =
    urlParams.get('code');

  if (code) {

    window.history.replaceState(
      {},
      document.title,
      window.location.pathname
    );

    processLineLogin(code);
  }
}

function getRedirectUri() {

  let uri =
    window.location.origin +
    window.location.pathname;

  if (
    uri.length > 1 &&
    uri.endsWith('/')
  ) {

    uri =
      uri.slice(0, -1);
  }

  return uri;
}

// ==========================================
// LINE LOGIN
// ==========================================
async function loginWithLine() {

  /*
   * Option 1: LIFF
   */
  if (
    CONFIG.LIFF_ID &&
    typeof liff !== 'undefined'
  ) {

    showToast(
      'กำลังเชื่อมต่อ LINE...',
      'info'
    );

    try {

      if (
        typeof liff.init === 'function'
      ) {

        await liff.init({
          liffId:
            CONFIG.LIFF_ID
        });
      }

      if (!liff.isLoggedIn()) {

        liff.login({
          redirectUri:
            window.location.href
        });

        return;
      }

      const profile =
        await liff.getProfile();

      await processLiffProfile(
        profile
      );

      return;

    } catch (err) {

      console.warn(
        'LIFF init failed, falling back to standard LINE OAuth:',
        err
      );
    }
  }

  /*
   * Option 2: Standard LINE OAuth
   */
  if (!CONFIG.LINE_CHANNEL_ID) {

    showToast(
      'กรุณากรอก LINE Channel ID หรือ LIFF ID ในแผงเหรัญญิกก่อนใช้งานระบบนี้',
      'error'
    );

    return;
  }

  if (!CONFIG.LINE_CHANNEL_SECRET) {

    showToast(
      'ยังไม่ได้ตั้งค่า LINE Channel Secret สำหรับ LINE OAuth',
      'error'
    );

    return;
  }

  const redirectUri =
    encodeURIComponent(
      getRedirectUri()
    );

  const state =
    'state-' + Date.now();

  const authUrl =
    `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${CONFIG.LINE_CHANNEL_ID}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid`;

  window.location.href =
    authUrl;
}

// ==========================================
// PROCESS LIFF PROFILE
// ==========================================
async function processLiffProfile(profile) {

  const lineUserId =
    profile.userId;

  const lineName =
    profile.displayName ||
    'LINE User';

  const picture =
    profile.pictureUrl ||
    '';

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL',
      'error'
    );

    return;
  }

  showToast(
    'กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...',
    'info'
  );

  try {

    const url =
      `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkLineUser&lineUserId=${encodeURIComponent(lineUserId)}`;

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success'
    ) {

      if (result.registered) {

        const userData = {

          lineUserId:
            lineUserId,

          name:
            result.name,

          studentId:
            normalizeStudentId(
              result.studentId
            ),

          picture:
            picture
        };

        saveUserSession(
          userData
        );

        showMainApplication(
          userData
        );

        showToast(
          `ยินดีต้อนรับกลับ คุณ ${userData.name}!`,
          'success'
        );

      } else {

        showRegistrationScreen(
          lineUserId,
          lineName
        );
      }

    } else {

      showToast(
        result.message ||
        'ไม่สามารถตรวจสอบข้อมูลกับเซิร์ฟเวอร์ได้',
        'error'
      );
    }

  } catch (err) {

    console.error(
      'LIFF Profile Check Error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์',
      'error'
    );
  }
}

// ==========================================
// DIRECT STUDENT LOGIN
// ==========================================
async function handleDirectStudentLogin(e) {

  e.preventDefault();

  const input =
    document.getElementById(
      'loginStudentIdInput'
    );

  const studentId =
    input
      ? input.value.trim()
      : '';

  if (!studentId) {
    return;
  }

  if (CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...',
      'info'
    );

    try {

      const response =
        await fetch(
          `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkStudentId&studentId=${encodeURIComponent(studentId)}`
        );

      const result =
        await response.json();

      if (
        result &&
        result.status === 'success' &&
        result.exists
      ) {

        const userData = {

          studentId:
            normalizeStudentId(
              studentId
            ),

          name:
            result.name ||
            ('นักศึกษา รหัส ' + studentId),

          email:
            'direct_login',

          picture:
            ''
        };

        saveUserSession(
          userData
        );

        showMainApplication(
          userData
        );

        showToast(
          `ยินดีต้อนรับคุณ ${userData.name}!`,
          'success'
        );

      } else {

        showToast(
          `ไม่พบรหัสนักศึกษา ${studentId} ในตารางรายชื่อห้องเรียนที่เป็นทางการ!`,
          'error'
        );
      }

    } catch (err) {

      console.warn(
        'Apps Script direct login check failed:',
        err
      );

      showToast(
        'ไม่สามารถเชื่อมต่อตรวจสอบรายชื่อใน Google Sheet ได้',
        'error'
      );
    }

  } else {

    showToast(
      'กรุณาตั้งค่า Google Apps Script Web App URL ในแผงเหรัญญิกก่อน',
      'error'
    );
  }
}

// ==========================================
// DEMO LOGIN
// ==========================================
function mockLocalLogin(studentId) {

  const userData = {

    studentId:
      normalizeStudentId(
        studentId
      ),

    name:
      'นักศึกษา รหัส ' +
      studentId,

    email:
      'direct_login',

    picture:
      ''
  };

  saveUserSession(
    userData
  );

  showMainApplication(
    userData
  );

  showToast(
    'เข้าสู่ระบบสำเร็จ (โหมดสาธิต)',
    'success'
  );
}

// ==========================================
// STANDARD LINE OAUTH
// ==========================================
async function processLineLogin(code) {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL',
      'error'
    );

    return;
  }

  if (!CONFIG.LINE_CHANNEL_SECRET) {

    showToast(
      'ยังไม่ได้ตั้งค่า LINE Channel Secret',
      'error'
    );

    return;
  }

  showToast(
    'กำลังเข้าสู่ระบบผ่าน LINE...',
    'info'
  );

  try {

    const redirectUri =
      getRedirectUri();

    const url =
      `${CONFIG.GOOGLE_SCRIPT_URL}?action=lineLogin&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}&channelId=${encodeURIComponent(CONFIG.LINE_CHANNEL_ID)}&channelSecret=${encodeURIComponent(CONFIG.LINE_CHANNEL_SECRET)}`;

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success'
    ) {

      if (result.registered) {

        const userData = {

          lineUserId:
            result.lineUserId,

          name:
            result.name,

          studentId:
            normalizeStudentId(
              result.studentId
            ),

          picture:
            result.picture || ''
        };

        saveUserSession(
          userData
        );

        showMainApplication(
          userData
        );

        showToast(
          `ยินดีต้อนรับกลับ คุณ ${userData.name}!`,
          'success'
        );

      } else {

        showRegistrationScreen(
          result.lineUserId,
          result.lineName
        );
      }

    } else {

      showToast(
        result.message ||
        'แลกเปลี่ยนรหัสโทเค็น LINE ไม่สำเร็จ',
        'error'
      );
    }

  } catch (err) {

    console.error(
      'LINE Code Exchange Error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการเชื่อมต่อ LINE Server',
      'error'
    );
  }
}

// ==========================================
// REGISTRATION
// ==========================================
function showRegistrationScreen(
  lineUserId,
  lineName
) {

  currentUser = {
    lineUserId:
      lineUserId,

    lineName:
      lineName
  };

  document.getElementById(
    'loginSection'
  ).style.display = 'none';

  document.getElementById(
    'mainAppSection'
  ).style.display = 'none';

  document.getElementById(
    'registerSection'
  ).style.display = 'block';

  const nameEl =
    document.getElementById(
      'registerLineNameText'
    );

  if (nameEl) {
    nameEl.textContent =
      lineName;
  }

  const idEl =
    document.getElementById(
      'registerStudentId'
    );

  if (idEl) {
    idEl.value = '';
  }
}

// ==========================================
// REGISTRATION SUBMIT
// ==========================================
async function handleRegistrationSubmit(e) {

  e.preventDefault();

  const input =
    document.getElementById(
      'registerStudentId'
    );

  const studentId =
    input
      ? input.value.trim()
      : '';

  const lineUserId =
    currentUser &&
    currentUser.lineUserId
      ? currentUser.lineUserId
      : '';

  const lineName =
    currentUser &&
    currentUser.lineName
      ? currentUser.lineName
      : '';

  if (!studentId) {

    showToast(
      'กรุณากรอกรหัสนักศึกษา',
      'error'
    );

    return;
  }

  const submitBtn =
    e.target.querySelector(
      'button[type="submit"]'
    );

  if (submitBtn) {

    submitBtn.disabled = true;

    submitBtn.innerHTML =
      `<i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจสอบรหัสในฐานข้อมูล...`;
  }

  try {

    let studentName =
      lineName ||
      ('นักศึกษา รหัส ' + studentId);

    if (!CONFIG.GOOGLE_SCRIPT_URL) {

      throw new Error(
        'ไม่ได้ตั้งค่า Google Apps Script'
      );
    }

    const response =
      await fetch(
        CONFIG.GOOGLE_SCRIPT_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'text/plain;charset=utf-8'
          },
          body:
            JSON.stringify({

              action:
                'registerLineUser',

              lineUserId:
                lineUserId,

              studentId:
                studentId,

              lineName:
                lineName
            })
        }
      );

    const result =
      await response.json();

    /*
     * IMPORTANT FIX:
     * ต้องให้ Apps Script ยืนยันสำเร็จก่อน
     * ถึงจะสร้าง session
     */
    if (
      !result ||
      result.status !== 'success'
    ) {

      throw new Error(
        result &&
        result.message
          ? result.message
          : 'ไม่สามารถเชื่อมโยงบัญชีได้'
      );
    }

    if (result.name) {
      studentName =
        result.name;
    }

    const userData = {

      lineUserId:
        lineUserId,

      studentId:
        normalizeStudentId(
          studentId
        ),

      name:
        studentName,

      picture:
        ''
    };

    saveUserSession(
      userData
    );

    showMainApplication(
      userData
    );

    showToast(
      `เชื่อมโยงบัญชี LINE กับคุณ ${userData.name} สำเร็จ!`,
      'success'
    );

  } catch (err) {

    console.error(
      'LINE Registration failed:',
      err
    );

    showToast(
      err.message ||
      'เกิดข้อผิดพลาดในการเชื่อมต่อ LINE',
      'error'
    );

  } finally {

    if (submitBtn) {

      submitBtn.disabled = false;

      submitBtn.innerHTML =
        `<i class="fa-solid fa-link"></i> ยืนยันเชื่อมต่อรหัสและเข้าหน้าหลัก`;
    }
  }
}

// ==========================================
// SAVE / LOGOUT SESSION
// ==========================================
function saveUserSession(userData) {

  currentUser =
    userData;

  localStorage.setItem(
    'kmitl_pay_user',
    JSON.stringify(
      userData
    )
  );
}

function logoutUser() {

  currentUser = null;

  localStorage.removeItem(
    'kmitl_pay_user'
  );

  const loginSection =
    document.getElementById(
      'loginSection'
    );

  const registerSection =
    document.getElementById(
      'registerSection'
    );

  const mainAppSection =
    document.getElementById(
      'mainAppSection'
    );

  const navControls =
    document.getElementById(
      'navControls'
    );

  if (loginSection) {
    loginSection.style.display =
      'block';
  }

  if (registerSection) {
    registerSection.style.display =
      'none';
  }

  if (mainAppSection) {
    mainAppSection.style.display =
      'none';
  }

  if (navControls) {
    navControls.style.display =
      'none';
  }

  const navAdminLink =
    document.getElementById(
      'navAdminLink'
    );

  if (navAdminLink) {
    navAdminLink.style.display =
      'none';
  }

  showToast(
    'ออกจากระบบเรียบร้อยแล้ว',
    'info'
  );
}

// ==========================================
// SHOW MAIN APPLICATION
// ==========================================
function showMainApplication(user) {

  if (!user) {
    return;
  }

  const name =
    user.name ||
    ('นักศึกษา รหัส ' +
      (user.studentId || ''));

  const displaySubtext =
    user.studentId ||
    user.email ||
    'KMITL Student';

  const userNameEl =
    document.getElementById(
      'userName'
    );

  if (userNameEl) {
    userNameEl.textContent =
      name;
  }

  const userEmailEl =
    document.getElementById(
      'userEmail'
    );

  if (userEmailEl) {
    userEmailEl.textContent =
      displaySubtext;
  }

  const userAvatarEl =
    document.getElementById(
      'userAvatar'
    );

  if (userAvatarEl) {
    userAvatarEl.textContent =
      name
        .trim()
        .charAt(0)
        .toUpperCase();
  }

  const welcomeStudentNameEl =
    document.getElementById(
      'welcomeStudentName'
    );

  if (welcomeStudentNameEl) {
    welcomeStudentNameEl.textContent =
      name;
  }

  const loginSec =
    document.getElementById(
      'loginSection'
    );

  if (loginSec) {
    loginSec.style.display =
      'none';
  }

  const regSec =
    document.getElementById(
      'registerSection'
    );

  if (regSec) {
    regSec.style.display =
      'none';
  }

  const mainSec =
    document.getElementById(
      'mainAppSection'
    );

  if (mainSec) {
    mainSec.style.display =
      'block';
  }

  const navCtrl =
    document.getElementById(
      'navControls'
    );

  if (navCtrl) {
    navCtrl.style.display =
      'flex';
  }

  const navAdminLink =
    document.getElementById(
      'navAdminLink'
    );

  if (navAdminLink) {

    const adminIds = [
      '69010115',
      '69010165'
    ];

    const uid =
      normalizeStudentId(
        user.studentId
      );

    if (
      uid &&
      adminIds.includes(uid)
    ) {

      navAdminLink.style.display =
        'inline-flex';

    } else {

      navAdminLink.style.display =
        'none';
    }
  }

  renderStudentDashboard();
  renderStudentHistoryTable();
}

// ==========================================
// VIEW SWITCHER
// ==========================================
function switchView(view) {

  currentView =
    view;

  const studentBtn =
    document.getElementById(
      'tabStudentBtn'
    );

  const adminBtn =
    document.getElementById(
      'tabAdminBtn'
    );

  const studentView =
    document.getElementById(
      'studentView'
    );

  const adminView =
    document.getElementById(
      'adminView'
    );

  if (view === 'student') {

    if (studentBtn) {
      studentBtn.classList.add(
        'active'
      );
    }

    if (adminBtn) {
      adminBtn.classList.remove(
        'active'
      );
    }

    if (studentView) {
      studentView.style.display =
        'block';
    }

    if (adminView) {
      adminView.style.display =
        'none';
    }

    renderStudentDashboard();

  } else {

    if (adminBtn) {
      adminBtn.classList.add(
        'active'
      );
    }

    if (studentBtn) {
      studentBtn.classList.remove(
        'active'
      );
    }

    if (studentView) {
      studentView.style.display =
        'none';
    }

    if (adminView) {
      adminView.style.display =
        'block';
    }

    renderAdminDashboard();
  }
}

// ==========================================
// GET CURRENT USER SUBMISSIONS
// ==========================================
function getCurrentUserSubmissions() {

  if (!currentUser) {
    return [];
  }

  const userId =
    normalizeStudentId(
      currentUser.studentId
    );

  if (!userId) {
    return [];
  }

  /*
   * IMPORTANT:
   * Student ID is the primary key.
   * ไม่ใช้ชื่อเป็นตัวจับหลัก
   */
  return submissions.filter(
    sub => {

      const sid =
        normalizeStudentId(
          sub.studentId
        );

      return sid === userId;
    }
  );
}

// ==========================================
// GET LATEST SUBMISSION FOR FEE
// ==========================================
function getLatestSubmissionForFee(
  userSubs,
  item
) {

  const relatedSubs =
    userSubs
      .filter(sub => {

        const sameName =
          sub.feeName === item.name;

        const sameId =
          item.id &&
          sub.feeId === item.id;

        return (
          sameName ||
          sameId
        );
      })
      .sort((a, b) => {

        const timeA =
          getSubmissionTime(a);

        const timeB =
          getSubmissionTime(b);

        /*
         * Newest timestamp first
         */
        if (timeB !== timeA) {
          return timeB - timeA;
        }

        /*
         * If timestamp cannot be parsed,
         * newest Sheet row wins.
         */
        return (
          getSubmissionRowNumber(b) -
          getSubmissionRowNumber(a)
        );
      });

  return relatedSubs.length
    ? relatedSubs[0]
    : null;
}

// ==========================================
// STUDENT DASHBOARD
// ==========================================
function renderStudentDashboard() {

  const grid =
    document.getElementById(
      'feeItemsGrid'
    );

  if (!grid) {
    return;
  }

  grid.innerHTML = '';

  const userSubsAll =
    getCurrentUserSubmissions();

  let unpaidTotal = 0;
  let paidTotal = 0;
  let pendingCount = 0;

  if (feeItems.length === 0) {

    grid.innerHTML = `
      <div style="
        grid-column:1/-1;
        text-align:center;
        padding:3rem;
        color:var(--text-muted);
      ">
        ไม่มีรายการเก็บเงินในระบบขณะนี้
      </div>
    `;

    const statUnpaid =
      document.getElementById(
        'statUnpaid'
      );

    const statPaid =
      document.getElementById(
        'statPaid'
      );

    const statPending =
      document.getElementById(
        'statPending'
      );

    if (statUnpaid) {
      statUnpaid.textContent =
        '฿0';
    }

    if (statPaid) {
      statPaid.textContent =
        '฿0';
    }

    if (statPending) {
      statPending.textContent =
        '0 รายการ';
    }

    renderStudentHistoryTable();

    return;
  }

  feeItems.forEach(item => {

    /*
     * IMPORTANT:
     * Only the LATEST payment record
     * determines current status.
     */
    const latestSub =
      getLatestSubmissionForFee(
        userSubsAll,
        item
      );

    let currentStatus =
      'Unpaid';

    let paidAmount = 0;
    let pendingAmount = 0;

    if (latestSub) {

      const status =
        normalizeStatus(
          latestSub.status
        );

      if (status === 'Approved') {

        currentStatus =
          'Approved';

        paidAmount =
          parseFloat(
            latestSub.amount
          ) || 0;

      } else if (status === 'Pending') {

        currentStatus =
          'Pending';

        pendingAmount =
          parseFloat(
            latestSub.amount
          ) || 0;

      } else if (status === 'Rejected') {

        currentStatus =
          'Rejected';
      }
    }

    /*
     * Calculate statistics
     */
    if (
      currentStatus === 'Approved'
    ) {

      paidTotal +=
        paidAmount;

      unpaidTotal +=
        Math.max(
          0,
          item.amount -
          paidAmount
        );

    } else if (
      currentStatus === 'Pending'
    ) {

      pendingCount++;

      unpaidTotal +=
        item.amount;

    } else {

      unpaidTotal +=
        item.amount;
    }

    /*
     * Badge
     */
    let statusBadge = '';

    if (
      currentStatus === 'Approved'
    ) {

      statusBadge = `
        <span class="fee-badge badge-paid">
          <i class="fa-solid fa-check"></i>
          ชำระแล้ว
        </span>
      `;

    } else if (
      currentStatus === 'Pending'
    ) {

      statusBadge = `
        <span class="fee-badge badge-pending">
          <i class="fa-solid fa-clock"></i>
          รอตรวจสอบ
        </span>
      `;

    } else if (
      currentStatus === 'Rejected'
    ) {

      statusBadge = `
        <span class="fee-badge badge-unpaid">
          <i class="fa-solid fa-circle-xmark"></i>
          ไม่ผ่าน - กรุณาส่งใหม่
        </span>
      `;

    } else {

      statusBadge = `
        <span class="fee-badge badge-unpaid">
          <i class="fa-solid fa-circle-exclamation"></i>
          ยังไม่ได้จ่าย
        </span>
      `;
    }

    const card =
      document.createElement(
        'div'
      );

    card.className =
      'glass-panel fee-card';

    card.innerHTML = `

      ${statusBadge}

      <div>

        <div class="fee-category">
          ${escapeHtml(item.category)}
        </div>

        <h4 class="fee-name">
          ${escapeHtml(item.name)}
        </h4>

        <p class="fee-description">
          ${escapeHtml(item.description)}
        </p>

      </div>

      <div>

        <div class="fee-meta">

          <div class="fee-amount">

            <span>จำนวนเงิน</span>

            <strong>
              ฿${Number(item.amount).toLocaleString()}
            </strong>

          </div>

          <div class="fee-due">

            <i class="fa-regular fa-calendar"></i>
            ครบกำหนด: ${escapeHtml(
              item.dueDate || '-'
            )}

          </div>

        </div>

        <button
          class="btn btn-primary"
          style="width:100%"
          onclick="openPaymentModal('${escapeHtml(item.id)}')"
        >
          <i class="fa-solid fa-qrcode"></i>
          ชำระเงิน / แนบสลิป
        </button>

      </div>
    `;

    grid.appendChild(card);
  });

  const statUnpaid =
    document.getElementById(
      'statUnpaid'
    );

  const statPaid =
    document.getElementById(
      'statPaid'
    );

  const statPending =
    document.getElementById(
      'statPending'
    );

  if (statUnpaid) {
    statUnpaid.textContent =
      `฿${unpaidTotal.toLocaleString()}`;
  }

  if (statPaid) {
    statPaid.textContent =
      `฿${paidTotal.toLocaleString()}`;
  }

  if (statPending) {
    statPending.textContent =
      `${pendingCount} รายการ`;
  }

  renderStudentHistoryTable();
}

// ==========================================
// STUDENT HISTORY
// ==========================================
function renderStudentHistoryTable() {

  const tbody =
    document.getElementById(
      'studentHistoryTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  const userSubs =
    getCurrentUserSubmissions()
      .sort((a, b) => {

        const timeA =
          getSubmissionTime(a);

        const timeB =
          getSubmissionTime(b);

        if (timeB !== timeA) {
          return timeB - timeA;
        }

        return (
          getSubmissionRowNumber(b) -
          getSubmissionRowNumber(a)
        );
      });

  if (userSubs.length === 0) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="6"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:2rem;
          "
        >
          ยังไม่มีประวัติการส่งสลิปชำระเงิน
        </td>
      </tr>
    `;

    return;
  }

  userSubs.forEach(sub => {

    const normStatus =
      normalizeStatus(
        sub.status
      );

    let statusClass =
      'badge-unpaid';

    let statusText =
      'ไม่ผ่าน';

    if (
      normStatus === 'Approved'
    ) {

      statusClass =
        'badge-paid';

      statusText =
        'อนุมัติเรียบร้อย';

    } else if (
      normStatus === 'Pending'
    ) {

      statusClass =
        'badge-pending';

      statusText =
        'รอเหรัญญิกตรวจ';
    }

    const tr =
      document.createElement(
        'tr'
      );

    const amount =
      parseFloat(
        sub.amount
      ) || 0;

    tr.innerHTML = `

      <td>
        ${escapeHtml(
          sub.timestamp || '-'
        )}
      </td>

      <td>
        <strong>
          ${escapeHtml(
            sub.feeName
          )}
        </strong>
      </td>

      <td>
        ฿${amount.toLocaleString()}
      </td>

      <td>

        <button
          class="btn btn-secondary btn-sm"
          onclick="viewAdminSlip('${escapeHtml(sub.id)}')"
        >
          <i class="fa-solid fa-image"></i>
          ดูสลิป
        </button>

      </td>

      <td>
        <span class="fee-badge ${statusClass}">
          ${statusText}
        </span>
      </td>

      <td>

        ${
          sub.slipUrl
            ? `
              <a
                href="${escapeHtml(sub.slipUrl)}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-secondary btn-sm"
              >
                <i class="fa-solid fa-external-link"></i>
                เปิด Drive
              </a>
            `
            : `
              <span
                style="color:var(--text-muted)"
              >
                -
              </span>
            `
        }

      </td>
    `;

    tbody.appendChild(tr);
  });
}

// ==========================================
// PROMPTPAY QR GENERATOR
// ==========================================
function generatePromptPayQRPayload(
  target,
  amount
) {

  const sanitize =
    target.replace(
      /[^0-9]/g,
      ''
    );

  let targetType =
    '01';

  let formattedTarget =
    sanitize;

  if (
    sanitize.length === 10
  ) {

    formattedTarget =
      '0066' +
      sanitize.substring(1);

    targetType =
      '01';

  } else if (
    sanitize.length === 13
  ) {

    targetType =
      '02';
  }

  const amountStr =
    amount
      ? amount.toFixed(2)
      : '0.00';

  const amountLen =
    ('0' + amountStr.length)
      .slice(-2);

  let payload =
    `00020101021129370016A000000677010111${targetType}${('0' + formattedTarget.length).slice(-2)}${formattedTarget}5802TH5303764${amount ? '54' + amountLen + amountStr : ''}6304`;

  const crc =
    crc16(payload);

  return payload + crc;
}

function crc16(data) {

  let crc =
    0xFFFF;

  for (
    let i = 0;
    i < data.length;
    i++
  ) {

    let x =
      ((crc >> 8) ^
        data.charCodeAt(i)) &
      0xFF;

    x ^=
      x >> 4;

    crc =
      (
        (crc << 8) ^
        (x << 12) ^
        (x << 5) ^
        x
      ) &
      0xFFFF;
  }

  return (
    '0000' +
    crc
      .toString(16)
      .toUpperCase()
  ).slice(-4);
}

// ==========================================
// PAYMENT MODAL
// ==========================================
function openPaymentModal(feeId) {

  selectedFeeItem =
    feeItems.find(
      f => f.id === feeId
    );

  if (!selectedFeeItem) {
    return;
  }

  currentPaymentQty =
    1;

  const title =
    document.getElementById(
      'modalFeeTitle'
    );

  if (title) {

    title.textContent =
      `ชำระเงิน: ${selectedFeeItem.name}`;
  }

  const receiver =
    document.getElementById(
      'modalPromptPayReceiver'
    );

  if (receiver) {

    receiver.textContent =
      `ชื่อบัญชี: ${CONFIG.PROMPTPAY_NAME} (PromptPay: ${maskPromptPay(CONFIG.PROMPTPAY_NUMBER)})`;
  }

  resetSlipUploader();

  updatePaymentQR();

  const modal =
    document.getElementById(
      'paymentModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

function changePaymentQty(delta) {

  const newQty =
    currentPaymentQty +
    delta;

  if (
    newQty < 1 ||
    newQty > 10
  ) {
    return;
  }

  currentPaymentQty =
    newQty;

  updatePaymentQR();
}

function updatePaymentQR() {

  if (!selectedFeeItem) {
    return;
  }

  const unitPrice =
    selectedFeeItem.amount;

  const totalAmount =
    unitPrice *
    currentPaymentQty;

  const qtyValue =
    document.getElementById(
      'qtyValue'
    );

  const qtyMinus =
    document.getElementById(
      'qtyMinus'
    );

  const qtyPlus =
    document.getElementById(
      'qtyPlus'
    );

  const qtySummaryText =
    document.getElementById(
      'qtySummaryText'
    );

  const qtySummaryTotal =
    document.getElementById(
      'qtySummaryTotal'
    );

  const modalAmount =
    document.getElementById(
      'modalPromptPayAmount'
    );

  if (qtyValue) {
    qtyValue.textContent =
      currentPaymentQty;
  }

  if (qtyMinus) {
    qtyMinus.disabled =
      currentPaymentQty <= 1;
  }

  if (qtyPlus) {
    qtyPlus.disabled =
      currentPaymentQty >= 10;
  }

  if (qtySummaryText) {

    qtySummaryText.textContent =
      `฿${unitPrice.toLocaleString(
        undefined,
        {
          minimumFractionDigits: 2
        }
      )} × ${currentPaymentQty} = `;
  }

  if (qtySummaryTotal) {

    qtySummaryTotal.textContent =
      `฿${totalAmount.toLocaleString(
        undefined,
        {
          minimumFractionDigits: 2
        }
      )}`;
  }

  if (modalAmount) {

    modalAmount.textContent =
      `฿${totalAmount.toFixed(2)}`;
  }

  const payload =
    generatePromptPayQRPayload(
      CONFIG.PROMPTPAY_NUMBER,
      totalAmount
    );

  const qrImg =
    document.getElementById(
      'qrImg'
    );

  if (qrImg) {

    qrImg.src =
      `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;

    qrImg.style.display =
      'block';
  }

  const qrCanvas =
    document.getElementById(
      'qrCanvas'
    );

  if (
    typeof QRCode !== 'undefined' &&
    qrCanvas
  ) {

    QRCode.toCanvas(
      qrCanvas,
      payload,
      {
        width: 220,
        margin: 2
      },
      function(error) {

        if (!error) {

          qrCanvas.style.display =
            'block';

          if (qrImg) {

            qrImg.style.display =
              'none';
          }
        }
      }
    );
  }
}

function closeModal(modalId) {

  const modal =
    document.getElementById(
      modalId
    );

  if (modal) {
    modal.classList.remove(
      'active'
    );
  }
}

// ==========================================
// SLIP UPLOAD
// ==========================================
function setupDragAndDrop() {

  const dropzone =
    document.getElementById(
      'slipDropzone'
    );

  if (!dropzone) {
    return;
  }

  [
    'dragenter',
    'dragover'
  ].forEach(eventName => {

    dropzone.addEventListener(
      eventName,
      (e) => {

        e.preventDefault();

        dropzone.classList.add(
          'dragover'
        );

      },
      false
    );
  });

  [
    'dragleave',
    'drop'
  ].forEach(eventName => {

    dropzone.addEventListener(
      eventName,
      (e) => {

        e.preventDefault();

        dropzone.classList.remove(
          'dragover'
        );

      },
      false
    );
  });

  dropzone.addEventListener(
    'drop',
    (e) => {

      const dt =
        e.dataTransfer;

      const files =
        dt.files;

      if (
        files.length > 0
      ) {

        processSelectedSlip(
          files[0]
        );
      }
    }
  );
}

function handleFileSelect(e) {

  const files =
    e.target.files;

  if (
    files.length > 0
  ) {

    processSelectedSlip(
      files[0]
    );
  }
}

function processSelectedSlip(file) {

  if (
    !file ||
    !file.type.startsWith(
      'image/'
    )
  ) {

    showToast(
      'กรุณาเลือกไฟล์รูปภาพสลิปเท่านั้น (PNG, JPG, JPEG)',
      'error'
    );

    return;
  }

  const reader =
    new FileReader();

  reader.onload =
    function(evt) {

      const previewBox =
        document.getElementById(
          'slipPreviewBox'
        );

      const previewImg =
        document.getElementById(
          'slipPreviewImg'
        );

      const scanStatus =
        document.getElementById(
          'slipScanResult'
        );

      if (scanStatus) {

        scanStatus.innerHTML =
          `<i class="fa-solid fa-spinner fa-spin"></i> กำลังประมวลผลและบีบอัดรูปภาพสลิป...`;
      }

      const img =
        new Image();

      img.onload =
        function() {

          try {

            const canvas =
              document.createElement(
                'canvas'
              );

            let w =
              img.width;

            let h =
              img.height;

            const MAX_DIM =
              1200;

            if (
              w > MAX_DIM ||
              h > MAX_DIM
            ) {

              if (w > h) {

                h =
                  Math.round(
                    (h * MAX_DIM) /
                    w
                  );

                w =
                  MAX_DIM;

              } else {

                w =
                  Math.round(
                    (w * MAX_DIM) /
                    h
                  );

                h =
                  MAX_DIM;
              }
            }

            canvas.width =
              w;

            canvas.height =
              h;

            const ctx =
              canvas.getContext(
                '2d'
              );

            ctx.drawImage(
              img,
              0,
              0,
              w,
              h
            );

            currentSlipBase64 =
              canvas.toDataURL(
                'image/jpeg',
                0.82
              );

            if (previewImg) {

              previewImg.src =
                currentSlipBase64;
            }

            if (previewBox) {

              previewBox.style.display =
                'block';
            }

            if (
              typeof jsQR !== 'undefined'
            ) {

              const imageData =
                ctx.getImageData(
                  0,
                  0,
                  w,
                  h
                );

              const code =
                jsQR(
                  imageData.data,
                  imageData.width,
                  imageData.height,
                  {
                    inversionAttempts:
                      'dontInvert'
                  }
                );

              if (code) {

                currentSlipQRData =
                  code.data;

                if (scanStatus) {

                  scanStatus.innerHTML = `
                    <i
                      class="fa-solid fa-circle-check"
                      style="color:var(--color-success);"
                    ></i>

                    <span>
                      ตรวจพบ QR Code บนสลิปเรียบร้อย
                      (Data Ref:
                      ${escapeHtml(
                        code.data.substring(
                          0,
                          20
                        )
                      )}...)
                    </span>
                  `;
                }

                showToast(
                  'ปรับขนาดและสแกน QR Code บนสลิปเรียบร้อย!',
                  'success'
                );

                return;
              }
            }

          } catch (err) {

            console.warn(
              'QR scanner / image compression notice:',
              err
            );

            currentSlipBase64 =
              evt.target.result;

            if (previewImg) {

              previewImg.src =
                currentSlipBase64;
            }

            if (previewBox) {

              previewBox.style.display =
                'block';
            }
          }

          currentSlipQRData =
            null;

          if (scanStatus) {

            scanStatus.innerHTML = `
              <i
                class="fa-solid fa-circle-check"
                style="color:var(--color-success);"
              ></i>

              <span>
                รูปภาพสลิปพร้อมส่งแล้ว
                (บีบอัดเรียบร้อย)
              </span>
            `;
          }

          showToast(
            'ปรับขนาดและพร้อมส่งสลิปเรียบร้อยแล้ว!',
            'success'
          );
        };

      img.onerror =
        function() {

          currentSlipBase64 =
            evt.target.result;

          if (previewImg) {

            previewImg.src =
              currentSlipBase64;
          }

          if (previewBox) {

            previewBox.style.display =
              'block';
          }

          if (scanStatus) {

            scanStatus.innerHTML =
              `<span>รูปภาพสลิปพร้อมส่งแล้ว</span>`;
          }
        };

      img.src =
        evt.target.result;
    };

  reader.onerror =
    function() {

      showToast(
        'เกิดข้อผิดพลาดในการอ่านไฟล์รูปภาพ',
        'error'
      );
    };

  reader.readAsDataURL(
    file
  );
}

function resetSlipUploader() {

  currentSlipBase64 =
    null;

  currentSlipQRData =
    null;

  const slipInput =
    document.getElementById(
      'slipInput'
    );

  if (slipInput) {
    slipInput.value = '';
  }

  const previewBox =
    document.getElementById(
      'slipPreviewBox'
    );

  if (previewBox) {

    previewBox.style.display =
      'none';
  }

  const remark =
    document.getElementById(
      'paymentRemark'
    );

  if (remark) {
    remark.value = '';
  }
}

// ==========================================
// SUBMIT PAYMENT
// ==========================================
async function handlePaymentSubmit(e) {

  e.preventDefault();

  if (!currentSlipBase64) {

    showToast(
      'กรุณาเลือกรูปภาพสลิปการโอนเงินก่อนส่ง (กำลังเปิดหน้าต่างเลือกไฟล์...)',
      'info'
    );

    const slipInput =
      document.getElementById(
        'slipInput'
      );

    if (slipInput) {
      slipInput.click();
    }

    return;
  }

  if (!currentUser) {

    showToast(
      'กรุณาเข้าสู่ระบบก่อนชำระเงิน',
      'error'
    );

    return;
  }

  const submitBtn =
    document.getElementById(
      'btnSubmitPayment'
    );

  if (submitBtn) {

    submitBtn.disabled =
      true;

    submitBtn.innerHTML =
      `<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึกลง Google Drive & Sheet...`;
  }

  const studentName =
    currentUser.name ||
    'นักศึกษา KMITL';

  const studentId =
    normalizeStudentId(
      currentUser.studentId
    );

  if (!studentId) {

    showToast(
      'ไม่พบรหัสนักศึกษาในบัญชีที่ Login',
      'error'
    );

    if (submitBtn) {

      submitBtn.disabled =
        false;

      submitBtn.innerHTML =
        `<i class="fa-solid fa-paper-plane"></i> ยืนยันการส่งสลิป`;
    }

    return;
  }

  const remarkEl =
    document.getElementById(
      'paymentRemark'
    );

  const newSubmission = {

    id:
      'sub-' +
      Date.now(),

    studentName:
      studentName,

    studentId:
      studentId,

    studentEmail:
      studentId,

    feeId:
      selectedFeeItem
        ? selectedFeeItem.id
        : 'fee-101',

    feeName:
      selectedFeeItem
        ? selectedFeeItem.name
        : 'ค่าห้องประจำเดือน',

    amount:
      selectedFeeItem
        ? selectedFeeItem.amount *
          currentPaymentQty
        : 100,

    status:
      'Pending',

    timestamp:
      new Date().toLocaleString(
        'th-TH'
      ),

    slipUrl:
      '',

    slipBase64:
      currentSlipBase64,

    qrRef:
      currentSlipQRData,

    remark:
      remarkEl &&
      remarkEl.value
        ? remarkEl.value
        : '-'
  };

  if (
    CONFIG.GOOGLE_SCRIPT_URL
  ) {

    try {

      newSubmission.action =
        'submitPayment';

      await postToGasReliable(
        newSubmission
      );

      showToast(
        'ส่งสลิปชำระเงินเรียบร้อย! บันทึกลง Google Sheet & Drive แล้ว',
        'success'
      );

      /*
       * Re-fetch after Apps Script
       * has had time to write.
       */
      setTimeout(
        fetchSubmissionsFromGas,
        2500
      );

    } catch (err) {

      console.warn(
        'Apps Script POST failed:',
        err
      );

      showToast(
        'เกิดข้อผิดพลาดในการส่งข้อมูล: ' +
        err.message,
        'error'
      );
    }
  }

  /*
   * Keep local copy temporarily
   */
  submissions.unshift(
    newSubmission
  );

  localStorage.setItem(
    'kmitl_pay_submissions',
    JSON.stringify(
      submissions
    )
  );

  if (submitBtn) {

    submitBtn.disabled =
      false;

    submitBtn.innerHTML =
      `<i class="fa-solid fa-paper-plane"></i> ยืนยันการส่งสลิป`;
  }

  closeModal(
    'paymentModal'
  );

  renderStudentDashboard();

  if (currentView === 'admin') {
    renderAdminDashboard();
  }
}

// ==========================================
// ADMIN DASHBOARD
// ==========================================
function renderAdminDashboard() {

  renderAdminFeeItemsTable();
  renderAdminSubmissionsTable();
}

function renderAdminFeeItemsTable() {

  const tbody =
    document.getElementById(
      'adminFeeItemsTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  if (feeItems.length === 0) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="5"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:1.5rem;
          "
        >
          ยังไม่มีรายการเก็บเงินที่สร้างไว้
        </td>
      </tr>
    `;

    return;
  }

  feeItems.forEach(item => {

    const tr =
      document.createElement(
        'tr'
      );

    tr.innerHTML = `

      <td>
        <strong>
          ${escapeHtml(item.name)}
        </strong>
      </td>

      <td>
        <span
          style="
            font-size:0.8rem;
            color:var(--kmitl-orange);
          "
        >
          ${escapeHtml(item.category)}
        </span>
      </td>

      <td>
        <strong
          style="
            color:var(--kmitl-gold);
          "
        >
          ฿${Number(item.amount).toLocaleString()}
        </strong>
      </td>

      <td>
        ${escapeHtml(
          item.dueDate || '-'
        )}
      </td>

      <td>

        <div
          style="
            display:flex;
            gap:6px;
          "
        >

          <button
            class="btn btn-success btn-sm"
            onclick="syncFeeItemToSheet('${escapeHtml(item.id)}')"
          >
            <i class="fa-solid fa-cloud-arrow-up"></i>
            ส่งไปชีท
          </button>

          <button
            class="btn btn-danger btn-sm"
            onclick="deleteFeeItem('${escapeHtml(item.id)}')"
          >
            <i class="fa-solid fa-trash"></i>
            ลบรายการ
          </button>

        </div>

      </td>
    `;

    tbody.appendChild(tr);
  });
}

// ==========================================
// ADMIN SUBMISSIONS
// ==========================================
function renderAdminSubmissionsTable() {

  const tbody =
    document.getElementById(
      'adminSubmissionsTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  if (submissions.length === 0) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="7"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:2rem;
          "
        >
          ยังไม่มีรายการส่งสลิปชำระเงินในระบบ
        </td>
      </tr>
    `;

    return;
  }

  submissions.forEach(sub => {

    const normStatus =
      normalizeStatus(
        sub.status
      );

    let statusClass =
      'badge-pending';

    let statusText =
      'รอตรวจสอบ';

    if (
      normStatus === 'Approved'
    ) {

      statusClass =
        'badge-paid';

      statusText =
        'อนุมัติแล้ว';

    } else if (
      normStatus === 'Rejected'
    ) {

      statusClass =
        'badge-unpaid';

      statusText =
        'ปฏิเสธแล้ว';
    }

    const isApproved =
      normStatus === 'Approved';

    const isRejected =
      normStatus === 'Rejected';

    const amount =
      parseFloat(
        sub.amount
      ) || 0;

    const tr =
      document.createElement(
        'tr'
      );

    tr.innerHTML = `

      <td>
        ${escapeHtml(
          sub.timestamp || '-'
        )}
      </td>

      <td>

        <div
          style="font-weight:600;"
        >
          ${escapeHtml(
            sub.studentName
          )}
        </div>

        <div
          style="
            font-size:0.775rem;
            color:var(--text-secondary);
          "
        >
          ${escapeHtml(
            sub.studentId ||
            sub.studentEmail ||
            ''
          )}
        </div>

      </td>

      <td>
        ${escapeHtml(
          sub.feeName
        )}
      </td>

      <td>
        <strong
          style="
            color:var(--kmitl-gold);
          "
        >
          ฿${amount.toLocaleString()}
        </strong>
      </td>

      <td>

        <button
          class="btn btn-secondary btn-sm"
          onclick="viewAdminSlip('${escapeHtml(sub.id)}')"
        >
          <i class="fa-solid fa-image"></i>
          ดูสลิป
          ${sub.qrRef ? '(สแกนแล้ว)' : ''}
        </button>

      </td>

      <td>

        <span
          class="fee-badge ${statusClass}"
        >
          ${statusText}
        </span>

      </td>

      <td>

        <div
          style="
            display:flex;
            gap:6px;
          "
        >

          <button
            class="btn btn-success btn-sm"
            onclick="updateStatus('${escapeHtml(sub.id)}', 'Approved')"
            ${isApproved ? 'disabled' : ''}
          >
            <i class="fa-solid fa-check"></i>

            ${
              isApproved
                ? 'อนุมัติแล้ว'
                : 'อนุมัติ'
            }

          </button>

          <button
            class="btn btn-danger btn-sm"
            onclick="updateStatus('${escapeHtml(sub.id)}', 'Rejected')"
            ${isRejected ? 'disabled' : ''}
          >
            <i class="fa-solid fa-xmark"></i>

            ${
              isRejected
                ? 'ปฏิเสธแล้ว'
                : 'ไม่อนุมัติ'
            }

          </button>

        </div>

      </td>
    `;

    tbody.appendChild(tr);
  });
}

// ==========================================
// VIEW SLIP
// ==========================================
function viewAdminSlip(subId) {

  const sub =
    submissions.find(
      s => s.id === subId
    );

  if (!sub) {
    return;
  }

  const fullImg =
    document.getElementById(
      'adminSlipFullImg'
    );

  const metaBox =
    document.getElementById(
      'adminSlipMeta'
    );

  const driveBtn =
    document.getElementById(
      'adminDriveLinkBtn'
    );

  if (fullImg) {

    fullImg.src =
      sub.slipBase64 ||
      (
        sub.slipUrl ||
        'https://via.placeholder.com/400x500?text=Slip+Image'
      );
  }

  if (metaBox) {

    metaBox.innerHTML = `

      <div>
        <strong>ชื่อผู้โอน:</strong>
        ${escapeHtml(
          sub.studentName
        )}

        (
        ${escapeHtml(
          sub.studentId ||
          sub.studentEmail ||
          ''
        )}
        )
      </div>

      <div>
        <strong>รายการ:</strong>
        ${escapeHtml(
          sub.feeName
        )}
        (฿${Number(
          sub.amount || 0
        ).toLocaleString()})
      </div>

      <div>
        <strong>เวลาส่ง:</strong>
        ${escapeHtml(
          sub.timestamp || '-'
        )}
      </div>

      ${
        sub.qrRef
          ? `
            <div
              style="
                margin-top:6px;
                color:#60a5fa;
              "
            >
              <strong>
                QR Payload Scan:
              </strong>

              ${escapeHtml(
                sub.qrRef
              )}
            </div>
          `
          : ''
      }

      ${
        sub.remark
          ? `
            <div>
              <strong>หมายเหตุ:</strong>
              ${escapeHtml(
                sub.remark
              )}
            </div>
          `
          : ''
      }
    `;
  }

  if (driveBtn) {

    driveBtn.href =
      sub.slipUrl ||
      '#';

    driveBtn.style.display =
      sub.slipUrl
        ? ''
        : 'none';
  }

  const modal =
    document.getElementById(
      'viewSlipModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

// ==========================================
// UPDATE PAYMENT STATUS
// ==========================================
async function updateStatus(
  subId,
  newStatus
) {

  const sub =
    submissions.find(
      s => s.id === subId
    );

  if (!sub) {
    return;
  }

  /*
   * Update local state immediately
   */
  sub.status =
    newStatus;

  localStorage.setItem(
    'kmitl_pay_submissions',
    JSON.stringify(
      submissions
    )
  );

  renderAdminDashboard();

  showToast(
    `กำลังอัปเดตสถานะเป็น ${
      newStatus === 'Approved'
        ? 'อนุมัติ'
        : 'ปฏิเสธ'
    }...`,
    'info'
  );

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    return;
  }

  try {

    const rowNumber =
      getSubmissionRowNumber(
        sub
      );

    /*
     * Student ID is now always preferred
     */
    const studentId =
      normalizeStudentId(
        sub.studentId ||
        sub.studentEmail
      );

    /*
     * Method 1: POST
     */
    try {

      await postToGasReliable({

        action:
          'updatePaymentStatus',

        studentId:
          studentId,

        studentName:
          sub.studentName || '',

        feeName:
          sub.feeName || '',

        status:
          newStatus,

        amount:
          sub.amount || 0,

        rowNumber:
          rowNumber
      });

    } catch (postErr) {

      console.warn(
        'POST update status warning:',
        postErr
      );
    }

    /*
     * Method 2: GET fallback
     */
    try {

      const params =
        new URLSearchParams({

          action:
            'updatePaymentStatus',

          studentId:
            studentId,

          feeName:
            sub.feeName || '',

          status:
            newStatus,

          amount:
            sub.amount || 0,

          rowNumber:
            rowNumber,

          studentName:
            sub.studentName || '',

          t:
            Date.now()
        });

      const url =
        CONFIG.GOOGLE_SCRIPT_URL +
        (
          CONFIG.GOOGLE_SCRIPT_URL.includes('?')
            ? '&'
            : '?'
        ) +
        params.toString();

      fetch(
        url,
        {
          mode: 'no-cors'
        }
      ).catch(
        e =>
          console.warn(
            'GET update status warning:',
            e
          )
      );

    } catch (getErr) {}

    showToast(
      'อัปเดตสถานะใน Google Sheet เรียบร้อยแล้ว',
      'success'
    );

    /*
     * Reload actual Sheet data
     */
    setTimeout(
      fetchSubmissionsFromGas,
      2500
    );

  } catch (err) {

    console.warn(
      'Update status in Sheet error:',
      err
    );

    showToast(
      'อัปเดตสถานะใน Local สำเร็จ แต่ส่งไป Sheet ไม่สำเร็จ: ' +
      err.message,
      'error'
    );
  }
}

// ==========================================
// SYNC ALL ADMIN DATA
// ==========================================
async function syncAllAdminData() {

  const btn =
    document.getElementById(
      'btnSyncAllData'
    );

  if (btn) {

    btn.disabled =
      true;

    btn.innerHTML =
      `<i class="fa-solid fa-spinner fa-spin"></i> กำลังซิงก์ข้อมูล...`;
  }

  showToast(
    'กำลังเชื่อมต่อซิงก์ข้อมูลกับ Google Sheet...',
    'info'
  );

  try {

    await fetchSubmissionsFromGas();

    await fetchFeeItemsFromGas();

    showToast(
      'ซิงก์ข้อมูลจาก Google Sheet สำเร็จแล้ว!',
      'success'
    );

  } catch (err) {

    console.warn(
      'Sync all error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการซิงก์ข้อมูล',
      'error'
    );

  } finally {

    if (btn) {

      btn.disabled =
        false;

      btn.innerHTML =
        `<i class="fa-solid fa-floppy-disk"></i> บันทึก & ซิงก์ข้อมูล Google Sheet`;
    }
  }
}

// ==========================================
// CREATE FEE
// ==========================================
function openCreateFeeModal() {

  const modal =
    document.getElementById(
      'createFeeModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

async function handleCreateFeeSubmit(e) {

  e.preventDefault();

  const category =
    document.getElementById(
      'newFeeCategory'
    ).value;

  const name =
    document.getElementById(
      'newFeeName'
    ).value;

  const desc =
    document.getElementById(
      'newFeeDesc'
    ).value;

  const amount =
    parseFloat(
      document.getElementById(
        'newFeeAmount'
      ).value
    );

  const dueDate =
    document.getElementById(
      'newFeeDueDate'
    ).value ||
    '2026-08-31';

  const newFee = {

    id:
      'fee-' +
      Date.now(),

    category:
      category,

    name:
      name,

    description:
      desc,

    amount:
      amount,

    dueDate:
      dueDate
  };

  feeItems.push(
    newFee
  );

  saveFeeItemsToStorage();

  closeModal(
    'createFeeModal'
  );

  document.getElementById(
    'newFeeCategory'
  ).value = '';

  document.getElementById(
    'newFeeName'
  ).value = '';

  document.getElementById(
    'newFeeDesc'
  ).value = '';

  document.getElementById(
    'newFeeAmount'
  ).value = '';

  renderStudentDashboard();
  renderAdminDashboard();

  showToast(
    'เพิ่มรายการเก็บเงินใหม่เรียบร้อยแล้ว!',
    'success'
  );

  if (CONFIG.GOOGLE_SCRIPT_URL) {

    try {

      await postToGasReliable({

        action:
          'saveFeeItem',

        feeItem:
          newFee
      });

      showToast(
        'ซิงก์บันทึกลง Google Sheet เรียบร้อยแล้ว!',
        'success'
      );

    } catch (err) {

      console.warn(
        'Sync fee item POST error:',
        err
      );
    }
  }
}

// ==========================================
// DELETE FEE
// ==========================================
async function deleteFeeItem(
  feeId
) {

  const itemToDelete =
    feeItems.find(
      f => f.id === feeId
    );

  if (
    !confirm(
      'คุณต้องการลบรายการเก็บเงินนี้ใช่หรือไม่?'
    )
  ) {
    return;
  }

  feeItems =
    feeItems.filter(
      f => f.id !== feeId
    );

  saveFeeItemsToStorage();

  renderAdminDashboard();

  showToast(
    'ลบรายการเก็บเงินเรียบร้อยแล้ว',
    'info'
  );

  if (CONFIG.GOOGLE_SCRIPT_URL) {

    try {

      await postToGasReliable({

        action:
          'deleteFeeItem',

        feeId:
          feeId,

        feeName:
          itemToDelete
            ? itemToDelete.name
            : ''
      });

      showToast(
        'ลบรายการออกจาก Google Sheet เรียบร้อยแล้ว',
        'success'
      );

    } catch (err) {

      console.warn(
        'Delete fee item error:',
        err
      );
    }
  }
}

// ==========================================
// SYNC FEE ITEM
// ==========================================
async function syncFeeItemToSheet(
  feeId
) {

  const item =
    feeItems.find(
      f => f.id === feeId
    );

  if (!item) {
    return;
  }

  showToast(
    'กำลังส่งรายการเก็บเงินไปยัง Google Sheet...',
    'info'
  );

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'กรุณาตั้งค่า Google Apps Script Web App URL ก่อน',
      'error'
    );

    return;
  }

  try {

    try {

      await postToGasReliable({

        action:
          'deleteFeeItem',

        feeId:
          feeId,

        feeName:
          item.name
      });

    } catch (e) {

      console.warn(
        'Pre-delete error:',
        e
      );
    }

    await postToGasReliable({

      action:
        'saveFeeItem',

      feeItem:
        item
    });

    showToast(
      'ส่งข้อมูลรายการเก็บเงินไปยัง Google Sheet สำเร็จแล้ว!',
      'success'
    );

  } catch (err) {

    console.warn(
      'Sync fee item error:',
      err
    );

    showToast(
      'ส่งข้อมูลไปยัง Google Sheet ไม่สำเร็จ',
      'error'
    );
  }
}

// ==========================================
// CONFIGURATION MODAL
// ==========================================
function openConfigModal() {

  const cfgScriptUrl =
    document.getElementById(
      'cfgScriptUrl'
    );

  const cfgLineChannelId =
    document.getElementById(
      'cfgLineChannelId'
    );

  const cfgLineChannelSecret =
    document.getElementById(
      'cfgLineChannelSecret'
    );

  const cfgPromptPay =
    document.getElementById(
      'cfgPromptPay'
    );

  const cfgPromptPayName =
    document.getElementById(
      'cfgPromptPayName'
    );

  if (cfgScriptUrl) {
    cfgScriptUrl.value =
      CONFIG.GOOGLE_SCRIPT_URL ||
      '';
  }

  if (cfgLineChannelId) {
    cfgLineChannelId.value =
      CONFIG.LINE_CHANNEL_ID ||
      '';
  }

  if (cfgLineChannelSecret) {
    cfgLineChannelSecret.value =
      CONFIG.LINE_CHANNEL_SECRET ||
      '';
  }

  if (cfgPromptPay) {
    cfgPromptPay.value =
      CONFIG.PROMPTPAY_NUMBER ||
      '';
  }

  if (cfgPromptPayName) {
    cfgPromptPayName.value =
      CONFIG.PROMPTPAY_NAME ||
      '';
  }

  const modal =
    document.getElementById(
      'configModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

// ==========================================
// SAVE CONFIG
// ==========================================
async function handleSaveConfig(e) {

  e.preventDefault();

  CONFIG.GOOGLE_SCRIPT_URL =
    document.getElementById(
      'cfgScriptUrl'
    ).value.trim();

  CONFIG.LINE_CHANNEL_ID =
    document.getElementById(
      'cfgLineChannelId'
    ).value.trim();

  CONFIG.LINE_CHANNEL_SECRET =
    document.getElementById(
      'cfgLineChannelSecret'
    ).value.trim();

  CONFIG.PROMPTPAY_NUMBER =
    document.getElementById(
      'cfgPromptPay'
    ).value.trim();

  CONFIG.PROMPTPAY_NAME =
    document.getElementById(
      'cfgPromptPayName'
    ).value.trim();

  saveConfigToStorage();

  closeModal(
    'configModal'
  );

  showToast(
    'บันทึกการตั้งค่าเชื่อมต่อ LINE & Google เรียบร้อยแล้ว!',
    'success'
  );

  if (CONFIG.GOOGLE_SCRIPT_URL) {

    try {

      await postToGasReliable({

        action:
          'saveSystemConfig',

        settings: {

          PROMPTPAY_NUMBER:
            CONFIG.PROMPTPAY_NUMBER,

          PROMPTPAY_NAME:
            CONFIG.PROMPTPAY_NAME
        }
      });

      showToast(
        'ซิงก์ข้อมูลตั้งค่าลง Google Sheet สำเร็จ!',
        'success'
      );

    } catch (err) {

      console.warn(
        'Sync config to GAS error:',
        err
      );
    }
  }
}

// ==========================================
// FETCH SYSTEM CONFIG
// ==========================================
async function fetchSystemConfigFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    return;
  }

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (
        CONFIG.GOOGLE_SCRIPT_URL.includes('?')
          ? '&'
          : '?'
      ) +
      'action=getSystemConfig&t=' +
      Date.now();

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success' &&
      result.data
    ) {

      const data =
        result.data;

      if (
        data.PROMPTPAY_NUMBER
      ) {

        CONFIG.PROMPTPAY_NUMBER =
          data.PROMPTPAY_NUMBER;
      }

      if (
        data.PROMPTPAY_NAME
      ) {

        CONFIG.PROMPTPAY_NAME =
          data.PROMPTPAY_NAME;
      }

      localStorage.setItem(
        'kmitl_pay_config',
        JSON.stringify(CONFIG)
      );
    }

  } catch (err) {

    console.warn(
      'Fetch system config error:',
      err
    );
  }
}

// ==========================================
// PROMPTPAY MASK
// ==========================================
function maskPromptPay(number) {

  if (!number) {
    return '';
  }

  const str =
    number
      .toString()
      .trim();

  if (
    str.length === 10
  ) {

    return (
      str.substring(0, 3) +
      '-xxx-' +
      str.substring(6)
    );

  } else if (
    str.length === 13
  ) {

    return (
      str.substring(0, 4) +
      '-xxxxx-xxx-' +
      str.substring(12)
    );
  }

  return (
    str.substring(
      0,
      Math.floor(
        str.length / 2
      )
    ) +
    'xxx'
  );
}

// ==========================================
// TOAST
// ==========================================
function showToast(
  message,
  type = 'info'
) {

  const container =
    document.getElementById(
      'toastContainer'
    );

  if (!container) {
    return;
  }

  const toast =
    document.createElement(
      'div'
    );

  toast.className =
    `toast toast-${type}`;

  let icon =
    'fa-info-circle';

  if (
    type === 'success'
  ) {
    icon =
      'fa-circle-check';
  }

  if (
    type === 'error'
  ) {
    icon =
      'fa-circle-exclamation';
  }

  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>
      ${escapeHtml(message)}
    </span>
  `;

  container.appendChild(
    toast
  );

  setTimeout(() => {

    toast.style.opacity =
      '0';

    setTimeout(() => {

      toast.remove();

    }, 300);

  }, 3500);
}

// ==========================================
// ESCAPE HTML
// ==========================================
function escapeHtml(str) {

  if (
    str === null ||
    str === undefined
  ) {
    return '';
  }

  return str
    .toString()
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}

// ==========================================
// RELIABLE POST TO GOOGLE APPS SCRIPT
// ==========================================
async function postToGasReliable(
  data
) {

  const gasUrl =
    CONFIG.GOOGLE_SCRIPT_URL;

  if (!gasUrl) {

    throw new Error(
      'ยังไม่ได้ตั้งค่า Google Script URL'
    );
  }

  /*
   * Only lightweight metadata goes
   * into query string.
   *
   * slipBase64 is kept in POST body.
   */
  const params =
    new URLSearchParams();

  for (
    const key in data
  ) {

    if (
      key !== 'slipBase64' &&
      data[key] !== null &&
      data[key] !== undefined &&
      typeof data[key] !== 'object' &&
      String(data[key]).length < 300
    ) {

      params.append(
        key,
        data[key]
      );
    }
  }

  const fetchUrl =
    gasUrl +
    (
      gasUrl.includes('?')
        ? '&'
        : '?'
    ) +
    params.toString();

  const jsonPayload =
    JSON.stringify(data);

  console.log(
    '[postToGasReliable] Sending request to GAS:',
    data.action
  );

  try {

    await fetch(
      fetchUrl,
      {
        method:
          'POST',

        mode:
          'no-cors',

        headers: {
          'Content-Type':
            'text/plain;charset=utf-8'
        },

        body:
          jsonPayload
      }
    );

    console.log(
      '[postToGasReliable] Fetch POST sent successfully'
    );

    return {
      status:
        'success'
    };

  } catch (err) {

    console.warn(
      '[postToGasReliable] fetch POST failed, attempting hidden form submission fallback...',
      err
    );

    return sendViaHiddenForm(
      gasUrl,
      data
    );
  }
}

// ==========================================
// HIDDEN FORM FALLBACK
// ==========================================
function sendViaHiddenForm(
  url,
  data
) {

  return new Promise(
    (resolve) => {

      try {

        let iframe =
          document.getElementById(
            'gas_hidden_iframe'
          );

        if (!iframe) {

          iframe =
            document.createElement(
              'iframe'
            );

          iframe.id =
            'gas_hidden_iframe';

          iframe.name =
            'gas_hidden_iframe';

          iframe.style.display =
            'none';

          document.body.appendChild(
            iframe
          );
        }

        const form =
          document.createElement(
            'form'
          );

        form.method =
          'POST';

        form.action =
          url;

        form.target =
          'gas_hidden_iframe';

        form.style.display =
          'none';

        const input =
          document.createElement(
            'input'
          );

        input.type =
          'hidden';

        input.name =
          'payload';

        input.value =
          JSON.stringify(data);

        form.appendChild(
          input
        );

        document.body.appendChild(
          form
        );

        form.submit();

        setTimeout(() => {

          form.remove();

          resolve({
            status:
              'success',

            fallback:
              true
          });

        }, 1500);

      } catch (e) {

        console.error(
          'Hidden form submission failed:',
          e
        );

        resolve({

          status:
            'error',

          message:
            e.message

        });
      }
    }
  );
}
```
