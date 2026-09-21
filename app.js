/**
 * KMITL Class Payment System - Core Application Logic
 * FIXED VERSION
 *
 * - Persistent Login
 * - Google Sheet Sync
 * - Latest payment status per fee
 * - Prevent duplicate paid items
 * - Student / Admin dashboard
 * - PromptPay QR
 * - Slip upload
 * - LINE / LIFF Login
 */

// ============================================================
// DEFAULT FEE ITEMS
// ============================================================

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

// ============================================================
// CONFIG
// ============================================================

let CONFIG = {};

try {
  CONFIG = JSON.parse(
    localStorage.getItem('kmitl_pay_config') || '{}'
  );
} catch (e) {
  CONFIG = {};
}

if (!CONFIG.GOOGLE_SCRIPT_URL) {
  CONFIG.GOOGLE_SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbw_OxjIFz_N6wJzF_fFhoJE6P561_jBoWMs8WDO9q8b1RsnYdaDtormoQnupF1oHQ8J/exec';
}

CONFIG.LINE_CHANNEL_ID =
  CONFIG.LINE_CHANNEL_ID || '2010801650';

/*
 * ไม่ hard-code Channel Secret กลับเข้ามาในไฟล์
 * ถ้ามีค่าเดิมอยู่ใน LocalStorage จะยังคงใช้งานได้
 */
CONFIG.LINE_CHANNEL_SECRET =
  CONFIG.LINE_CHANNEL_SECRET || '';

CONFIG.LIFF_ID =
  CONFIG.LIFF_ID || '2010801650-te43AoZe';

CONFIG.PROMPTPAY_NUMBER =
  CONFIG.PROMPTPAY_NUMBER || '0891234567';

CONFIG.PROMPTPAY_NAME =
  CONFIG.PROMPTPAY_NAME ||
  'เหรัญญิกประจำห้อง (KMITL Pay)';

if (CONFIG.ALLOW_NON_KMITL_IN_DEMO === undefined) {
  CONFIG.ALLOW_NON_KMITL_IN_DEMO = false;
}

localStorage.setItem(
  'kmitl_pay_config',
  JSON.stringify(CONFIG)
);

// ============================================================
// GLOBAL STATE
// ============================================================

let currentUser = null;
let currentView = 'student';

let selectedFeeItem = null;

let currentSlipBase64 = null;
let currentSlipQRData = null;

let currentPaymentQty = 1;

let feeItems = [];

try {
  feeItems =
    JSON.parse(
      localStorage.getItem('kmitl_pay_fee_items') || 'null'
    ) || DEFAULT_FEE_ITEMS;
} catch (e) {
  feeItems = DEFAULT_FEE_ITEMS;
}

let submissions = [];

try {
  submissions =
    JSON.parse(
      localStorage.getItem('kmitl_pay_submissions') || '[]'
    ) || [];
} catch (e) {
  submissions = [];
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener(
  'DOMContentLoaded',
  async function () {

    console.log('[APP] Initializing KMITL Payment System...');

    setupDragAndDrop();
    checkGasConfigAlert();

    // --------------------------------------------
    // ถ้ามี LINE OAuth code ให้จัดการก่อน
    // --------------------------------------------

    const hasLineCode = checkLineAuthCode();

    // --------------------------------------------
    // Admin page
    // --------------------------------------------

    if (
      window.location.pathname
        .toLowerCase()
        .includes('admin.html')
    ) {

      currentView = 'admin';

      renderAdminDashboard();

      fetchSubmissionsFromGas();
      fetchFeeItemsFromGas();
      fetchSystemConfigFromGas();

      return;
    }

    // --------------------------------------------
    // ถ้าไม่มี OAuth code
    // ให้ restore login ก่อน
    // --------------------------------------------

    if (!hasLineCode) {

      const restored = checkSavedSession();

      if (!restored) {

        // ยังไม่มี session ค่อยตรวจ LIFF
        const liffLoggedIn =
          await checkLiffAutoLogin();

        if (!liffLoggedIn && !currentUser) {
          showLoginScreen();
        }
      }
    }

    // --------------------------------------------
    // โหลดข้อมูลจาก Google Sheet
    // --------------------------------------------

    fetchSubmissionsFromGas();
    fetchFeeItemsFromGas();
    fetchSystemConfigFromGas();

    console.log('[APP] Initialization complete.');
  }
);

// ============================================================
// BASIC HELPERS
// ============================================================

function normalizeStatus(status) {

  if (!status) {
    return 'Pending';
  }

  const str =
    String(status)
      .trim()
      .toLowerCase();

  if (
    str.includes('approved') ||
    str.includes('อนุมัติ') ||
    str.includes('ชำระแล้ว') ||
    str.includes('paid') ||
    str === 'ผ่าน'
  ) {
    return 'Approved';
  }

  if (
    str.includes('reject') ||
    str.includes('ปฏิเสธ') ||
    str.includes('ไม่อนุมัติ') ||
    str.includes('ไม่ผ่าน')
  ) {
    return 'Rejected';
  }

  return 'Pending';
}

function normalizeFeeKey(value) {

  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getFirstValue(row, keys) {

  for (const key of keys) {

    if (
      row &&
      row[key] !== undefined &&
      row[key] !== null &&
      String(row[key]).trim() !== ''
    ) {
      return row[key];
    }
  }

  return '';
}

function getPaymentTimestamp(payment) {

  if (!payment) {
    return 0;
  }

  // rowNumber มีความน่าเชื่อถือสำหรับ Sheet
  if (
    payment.rowNumber !== undefined &&
    Number(payment.rowNumber) > 0
  ) {
    return Number(payment.rowNumber);
  }

  const timestamp =
    new Date(
      payment.timestamp || ''
    ).getTime();

  if (!isNaN(timestamp)) {
    return timestamp;
  }

  return 0;
}

function getLatestPaymentByFee(userSubs) {

  const latestMap = {};

  if (!Array.isArray(userSubs)) {
    return latestMap;
  }

  userSubs.forEach(sub => {

    const feeId =
      normalizeFeeKey(sub.feeId);

    const feeName =
      normalizeFeeKey(sub.feeName);

    const key =
      feeId || feeName;

    if (!key) {
      return;
    }

    const existing =
      latestMap[key];

    if (!existing) {

      latestMap[key] = sub;

      return;
    }

    if (
      getPaymentTimestamp(sub) >=
      getPaymentTimestamp(existing)
    ) {

      latestMap[key] = sub;
    }
  });

  return latestMap;
}

function getCurrentUserId() {

  if (!currentUser) {
    return '';
  }

  return String(
    currentUser.studentId ||
    ''
  ).trim();
}

function getUserSubmissions() {

  if (!currentUser) {
    return [];
  }

  const userId =
    getCurrentUserId();

  const userName =
    String(
      currentUser.name || ''
    ).trim();

  return submissions.filter(sub => {

    const sid =
      String(
        sub.studentId ||
        sub.studentEmail ||
        ''
      ).trim();

    const name =
      String(
        sub.studentName || ''
      ).trim();

    return (
      (userId && sid === userId) ||
      (!sid && userName && name === userName)
    );
  });
}

// ============================================================
// GOOGLE SHEET - FETCH PAYMENTS
// ============================================================

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
      !result ||
      result.status !== 'success' ||
      !Array.isArray(result.data)
    ) {
      return;
    }

    const sheetSubmissions =
      result.data.map((row, idx) => {

        const studentId =
          String(
            getFirstValue(
              row,
              [
                'Student ID',
                'รหัสนักศึกษา',
                'ข้อมูลประจำตัว/รหัส',
                'อีเมลนักศึกษา',
                'studentId',
                'studentID'
              ]
            )
          ).trim();

        const feeName =
          String(
            getFirstValue(
              row,
              [
                'รายการชำระเงิน',
                'feeName',
                'Fee Name'
              ]
            )
          ).trim();

        const feeId =
          String(
            getFirstValue(
              row,
              [
                'Fee ID',
                'feeId',
                'FeeID'
              ]
            )
          ).trim();

        const rowNumber =
          Number(
            getFirstValue(
              row,
              [
                'rowNumber',
                'Row Number'
              ]
            )
          ) || (idx + 2);

        return {

          id:
            'gas-' +
            rowNumber,

          rowNumber:
            rowNumber,

          timestamp:
            String(
              getFirstValue(
                row,
                [
                  'วันเวลาที่ส่ง',
                  'Timestamp',
                  'timestamp'
                ]
              ) || ''
            ),

          studentName:
            String(
              getFirstValue(
                row,
                [
                  'ชื่อ-นามสกุล',
                  'studentName',
                  'Name'
                ]
              ) || ''
            ),

          studentId:
            studentId,

          studentEmail:
            studentId,

          feeId:
            feeId,

          feeName:
            feeName,

          amount:
            parseFloat(
              getFirstValue(
                row,
                [
                  'จำนวนเงิน (บาท)',
                  'จำนวนเงิน',
                  'amount'
                ]
              )
            ) || 0,

          status:
            normalizeStatus(
              getFirstValue(
                row,
                [
                  'สถานะ',
                  'status',
                  'Status'
                ]
              )
            ),

          slipUrl:
            String(
              getFirstValue(
                row,
                [
                  'ลิงก์สลิปใน Google Drive',
                  'slipUrl',
                  'Slip URL'
                ]
              ) || ''
            ),

          qrRef:
            String(
              getFirstValue(
                row,
                [
                  'ข้อมูล QR Ref บนสลิป',
                  'qrRef',
                  'QR Ref'
                ]
              ) || ''
            ),

          remark:
            String(
              getFirstValue(
                row,
                [
                  'หมายเหตุ',
                  'remark',
                  'Remark'
                ]
              ) || ''
            ),

          slipBase64:
            row.slipBase64 || ''
        };
      });

    // ใหม่สุดก่อน
    sheetSubmissions.sort(
      (a, b) =>
        getPaymentTimestamp(b) -
        getPaymentTimestamp(a)
    );

    submissions =
      sheetSubmissions;

    localStorage.setItem(
      'kmitl_pay_submissions',
      JSON.stringify(submissions)
    );

    console.log(
      '[GAS] Payments synced:',
      submissions.length
    );

    // --------------------------------------------
    // Render ใหม่หลัง Sheet โหลดเสร็จ
    // --------------------------------------------

    if (currentUser) {
      renderStudentDashboard();
      renderStudentHistoryTable();
    }

    if (currentView === 'admin') {
      renderAdminDashboard();
    }

  } catch (err) {

    console.warn(
      '[GAS] Fetch submissions error:',
      err
    );
  }
}

// ============================================================
// GOOGLE SHEET - FETCH FEE ITEMS
// ============================================================

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
      !result ||
      result.status !== 'success' ||
      !Array.isArray(result.data)
    ) {
      return;
    }

    const cloudItems =
      result.data.map(item => {

        let cleanDueDate =
          item.dueDate
            ? String(item.dueDate)
            : '';

        if (
          cleanDueDate.includes('GMT') ||
          cleanDueDate.includes('T')
        ) {

          try {

            const d =
              new Date(cleanDueDate);

            if (!isNaN(d.getTime())) {

              cleanDueDate =
                d.toISOString()
                  .split('T')[0];
            }

          } catch (e) {}
        }

        return {

          id:
            item.id ||
            ('fee-' + Date.now() + Math.random()),

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
            parseFloat(item.amount) || 0,

          dueDate:
            cleanDueDate
        };
      });

    // Cloud เป็น source หลัก
    feeItems =
      cloudItems;

    saveFeeItemsToStorage();

    renderAdminFeeItemsTable();

    if (currentUser) {
      renderStudentDashboard();
    }

  } catch (err) {

    console.warn(
      '[GAS] Fetch fee items error:',
      err
    );
  }
}

// ============================================================
// LIFF AUTO LOGIN
// ============================================================

async function checkLiffAutoLogin() {

  if (
    !CONFIG.LIFF_ID ||
    typeof liff === 'undefined'
  ) {
    return false;
  }

  try {

    await liff.init({
      liffId: CONFIG.LIFF_ID
    });

    if (liff.isLoggedIn()) {

      const profile =
        await liff.getProfile();

      await processLiffProfile(
        profile
      );

      return true;
    }

  } catch (err) {

    console.warn(
      '[LIFF] Auto-login check:',
      err
    );
  }

  return false;
}

// ============================================================
// GOOGLE SIGN-IN
// ============================================================

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
      typeof google === 'undefined' ||
      !google.accounts ||
      !google.accounts.id
    ) {
      return;
    }

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

  }, 500);
}

// ============================================================
// STORAGE
// ============================================================

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

// ============================================================
// GAS STATUS
// ============================================================

function checkGasConfigAlert() {

  const alertBox =
    document.getElementById(
      'gasStatusAlert'
    );

  if (!alertBox) {
    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    alertBox.style.display =
      'block';

    alertBox.innerHTML = `
      <div style="
        background: rgba(245,158,11,.15);
        border:1px solid rgba(245,158,11,.4);
        color:var(--color-warning);
        padding:12px 16px;
        border-radius:12px;
        font-size:.875rem;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
      ">
        <div>
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>ยังไม่ได้ตั้งค่า Google Apps Script</strong>
        </div>

        <button
          class="btn btn-secondary btn-sm"
          onclick="openConfigModal()"
        >
          ตั้งค่า
        </button>
      </div>
    `;

  } else {

    alertBox.style.display =
      'block';

    alertBox.innerHTML = `
      <div style="
        background:rgba(16,185,129,.15);
        border:1px solid rgba(16,185,129,.4);
        color:var(--color-success);
        padding:12px 16px;
        border-radius:12px;
        font-size:.875rem;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
      ">
        <div>
          <i class="fa-solid fa-circle-check"></i>
          <strong>เชื่อมต่อ Google Apps Script แล้ว</strong>
        </div>

        <button
          class="btn btn-secondary btn-sm"
          onclick="openConfigModal()"
        >
          แก้ไข
        </button>
      </div>
    `;
  }
}

// ============================================================
// SESSION - REMEMBER LOGIN
// ============================================================

function checkSavedSession() {

  const savedUser =
    localStorage.getItem(
      'kmitl_pay_user'
    );

  if (savedUser) {

    try {

      const parsedUser =
        JSON.parse(savedUser);

      if (
        parsedUser &&
        parsedUser.studentId &&
        String(
          parsedUser.studentId
        ).trim() !== ''
      ) {

        currentUser = {

          ...parsedUser,

          studentId:
            String(
              parsedUser.studentId
            ).trim()
        };

        console.log(
          '[SESSION] Restored:',
          currentUser.studentId
        );

        showMainApplication(
          currentUser
        );

        return true;
      }

      localStorage.removeItem(
        'kmitl_pay_user'
      );

    } catch (err) {

      console.warn(
        '[SESSION] Invalid saved session:',
        err
      );

      localStorage.removeItem(
        'kmitl_pay_user'
      );
    }
  }

  return false;
}

function showLoginScreen() {

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
}

// ============================================================
// LINE AUTH CODE
// ============================================================

function checkLineAuthCode() {

  const urlParams =
    new URLSearchParams(
      window.location.search
    );

  const code =
    urlParams.get('code');

  if (!code) {
    return false;
  }

  // ล้าง code ออกจาก URL
  window.history.replaceState(
    {},
    document.title,
    window.location.pathname
  );

  processLineLogin(code);

  return true;
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

// ============================================================
// LINE LOGIN
// ============================================================

async function loginWithLine() {

  if (
    CONFIG.LIFF_ID &&
    typeof liff !== 'undefined'
  ) {

    showToast(
      'กำลังเชื่อมต่อ LINE...',
      'info'
    );

    try {

      await liff.init({
        liffId:
          CONFIG.LIFF_ID
      });

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
        '[LINE] LIFF failed:',
        err
      );
    }
  }

  // Standard LINE OAuth
  if (!CONFIG.LINE_CHANNEL_ID) {

    showToast(
      'กรุณาตั้งค่า LINE Channel ID',
      'error'
    );

    return;
  }

  const redirectUri =
    encodeURIComponent(
      getRedirectUri()
    );

  const state =
    'state-' +
    Date.now();

  const authUrl =
    'https://access.line.me/oauth2/v2.1/authorize' +
    '?response_type=code' +
    '&client_id=' +
    encodeURIComponent(
      CONFIG.LINE_CHANNEL_ID
    ) +
    '&redirect_uri=' +
    redirectUri +
    '&state=' +
    state +
    '&scope=profile%20openid';

  window.location.href =
    authUrl;
}

// ============================================================
// PROCESS LIFF PROFILE
// ============================================================

async function processLiffProfile(
  profile
) {

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
      'ระบบไม่ได้ตั้งค่า Google Apps Script',
      'error'
    );

    return;
  }

  showToast(
    'กำลังตรวจสอบข้อมูลนักศึกษา...',
    'info'
  );

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      '?action=checkLineUser' +
      '&lineUserId=' +
      encodeURIComponent(
        lineUserId
      );

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
            result.name ||
            lineName,

          studentId:
            result.studentId,

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
        result?.message ||
        'ไม่สามารถตรวจสอบข้อมูลได้',
        'error'
      );
    }

  } catch (err) {

    console.error(
      '[LIFF] Profile error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์',
      'error'
    );
  }
}

// ============================================================
// DIRECT STUDENT LOGIN
// ============================================================

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

    showToast(
      'กรุณากรอกรหัสนักศึกษา',
      'error'
    );

    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'กรุณาตั้งค่า Google Apps Script ก่อน',
      'error'
    );

    return;
  }

  showToast(
    'กำลังตรวจสอบรหัสนักศึกษา...',
    'info'
  );

  try {

    const response =
      await fetch(
        CONFIG.GOOGLE_SCRIPT_URL +
        '?action=checkStudentId&studentId=' +
        encodeURIComponent(
          studentId
        )
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
          studentId,

        name:
          result.name ||
          `นักศึกษา รหัส ${studentId}`,

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
        `ไม่พบรหัสนักศึกษา ${studentId} ในรายชื่อ`,
        'error'
      );
    }

  } catch (err) {

    console.error(
      '[LOGIN] Error:',
      err
    );

    showToast(
      'ไม่สามารถเชื่อมต่อ Google Sheet ได้',
      'error'
    );
  }
}

// ============================================================
// MOCK LOGIN
// ============================================================

function mockLocalLogin(studentId) {

  const userData = {

    studentId:
      String(studentId).trim(),

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

// ============================================================
// LINE OAUTH LOGIN
// ============================================================

async function processLineLogin(
  code
) {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'ระบบไม่ได้ตั้งค่า Google Apps Script',
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

    const params =
      new URLSearchParams({

        action:
          'lineLogin',

        code:
          code,

        redirect_uri:
          redirectUri,

        channelId:
          CONFIG.LINE_CHANNEL_ID,

        channelSecret:
          CONFIG.LINE_CHANNEL_SECRET
      });

    const response =
      await fetch(
        CONFIG.GOOGLE_SCRIPT_URL +
        '?' +
        params.toString()
      );

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
            result.studentId,

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
        result?.message ||
        'เข้าสู่ระบบ LINE ไม่สำเร็จ',
        'error'
      );
    }

  } catch (err) {

    console.error(
      '[LINE] Login error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการเชื่อมต่อ LINE',
      'error'
    );
  }
}

// ============================================================
// LINE REGISTRATION
// ============================================================

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

  const loginSection =
    document.getElementById(
      'loginSection'
    );

  const mainSection =
    document.getElementById(
      'mainAppSection'
    );

  const registerSection =
    document.getElementById(
      'registerSection'
    );

  if (loginSection) {
    loginSection.style.display =
      'none';
  }

  if (mainSection) {
    mainSection.style.display =
      'none';
  }

  if (registerSection) {
    registerSection.style.display =
      'block';
  }

  const nameEl =
    document.getElementById(
      'registerLineNameText'
    );

  if (nameEl) {
    nameEl.textContent =
      lineName;
  }

  const idInput =
    document.getElementById(
      'registerStudentId'
    );

  if (idInput) {
    idInput.value = '';
  }
}

async function handleRegistrationSubmit(
  e
) {

  e.preventDefault();

  const idInput =
    document.getElementById(
      'registerStudentId'
    );

  const studentId =
    idInput
      ? idInput.value.trim()
      : '';

  if (!studentId) {

    showToast(
      'กรุณากรอกรหัสนักศึกษา',
      'error'
    );

    return;
  }

  const lineUserId =
    currentUser?.lineUserId || '';

  const lineName =
    currentUser?.lineName || '';

  const submitBtn =
    e.target.querySelector(
      'button[type="submit"]'
    );

  if (submitBtn) {

    submitBtn.disabled =
      true;

    submitBtn.innerHTML =
      `<i class="fa-solid fa-spinner fa-spin"></i>
       กำลังตรวจสอบ...`;
  }

  try {

    let studentName =
      lineName ||
      `นักศึกษา รหัส ${studentId}`;

    if (CONFIG.GOOGLE_SCRIPT_URL) {

      try {

        const response =
          await fetch(
            CONFIG.GOOGLE_SCRIPT_URL,
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'text/plain;charset=utf-8'
              },
              body: JSON.stringify({

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

        if (
          result &&
          result.status === 'success' &&
          result.name
        ) {

          studentName =
            result.name;
        }

      } catch (err) {

        console.warn(
          '[LINE] Registration warning:',
          err
        );
      }
    }

    const userData = {

      lineUserId:
        lineUserId,

      studentId:
        studentId,

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
      `เชื่อมโยงบัญชี LINE สำเร็จ!`,
      'success'
    );

  } catch (err) {

    console.error(
      '[LINE] Registration failed:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการเชื่อมต่อ LINE',
      'error'
    );

  } finally {

    if (submitBtn) {

      submitBtn.disabled =
        false;

      submitBtn.innerHTML =
        `<i class="fa-solid fa-link"></i>
         ยืนยันเชื่อมต่อรหัสและเข้าหน้าหลัก`;
    }
  }
}

// ============================================================
// SAVE / LOGOUT SESSION
// ============================================================

function saveUserSession(
  userData
) {

  if (
    !userData ||
    !userData.studentId
  ) {

    console.warn(
      '[SESSION] Invalid user:',
      userData
    );

    return false;
  }

  currentUser = {

    ...userData,

    studentId:
      String(
        userData.studentId
      ).trim()
  };

  localStorage.setItem(
    'kmitl_pay_user',
    JSON.stringify(currentUser)
  );

  console.log(
    '[SESSION] Saved:',
    currentUser.studentId
  );

  return true;
}

function logoutUser() {

  currentUser = null;

  localStorage.removeItem(
    'kmitl_pay_user'
  );

  showLoginScreen();

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

// ============================================================
// SHOW MAIN APP
// ============================================================

function showMainApplication(
  user
) {

  if (!user) {
    return;
  }

  currentUser =
    user;

  const name =
    user.name ||
    `นักศึกษา รหัส ${user.studentId || ''}`;

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

  const avatar =
    document.getElementById(
      'userAvatar'
    );

  if (avatar) {
    avatar.textContent =
      name
        .trim()
        .charAt(0)
        .toUpperCase();
  }

  const welcome =
    document.getElementById(
      'welcomeStudentName'
    );

  if (welcome) {
    welcome.textContent =
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

    if (
      user.studentId &&
      adminIds.includes(
        String(
          user.studentId
        ).trim()
      )
    ) {

      navAdminLink.style.display =
        'inline-flex';

    } else {

      navAdminLink.style.display =
        'none';
    }
  }

  renderStudentDashboard();
}

// ============================================================
// VIEW SWITCH
// ============================================================

function switchView(
  view
) {

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

    if (studentBtn)
      studentBtn.classList.add(
        'active'
      );

    if (adminBtn)
      adminBtn.classList.remove(
        'active'
      );

    if (studentView)
      studentView.style.display =
        'block';

    if (adminView)
      adminView.style.display =
        'none';

    renderStudentDashboard();

  } else {

    if (adminBtn)
      adminBtn.classList.add(
        'active'
      );

    if (studentBtn)
      studentBtn.classList.remove(
        'active'
      );

    if (studentView)
      studentView.style.display =
        'none';

    if (adminView)
      adminView.style.display =
        'block';

    renderAdminDashboard();
  }
}

// ============================================================
// STUDENT DASHBOARD
// ============================================================

function renderStudentDashboard() {

  const grid =
    document.getElementById(
      'feeItemsGrid'
    );

  if (!grid) {
    return;
  }

  grid.innerHTML = '';

  if (!currentUser) {
    return;
  }

  const userSubs =
    getUserSubmissions();

  const latestPayments =
    getLatestPaymentByFee(
      userSubs
    );

  let unpaidTotal = 0;
  let paidTotal = 0;
  let pendingCount = 0;

  // --------------------------------------------
  // ไม่มีรายการ
  // --------------------------------------------

  if (!Array.isArray(feeItems) || feeItems.length === 0) {

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

    setText(
      'statUnpaid',
      '฿0'
    );

    setText(
      'statPaid',
      '฿0'
    );

    setText(
      'statPending',
      '0 รายการ'
    );

    renderStudentHistoryTable();

    return;
  }

  // --------------------------------------------
  // วน Fee Items
  // --------------------------------------------

  feeItems.forEach(item => {

    const itemId =
      normalizeFeeKey(
        item.id
      );

    const itemName =
      normalizeFeeKey(
        item.name
      );

    let latestPayment =
      null;

    // หาโดย Fee ID ก่อน
    if (itemId) {

      latestPayment =
        latestPayments[itemId] ||
        null;
    }

    // ถ้าไม่มี หาโดยชื่อ
    if (!latestPayment && itemName) {

      latestPayment =
        latestPayments[itemName] ||
        null;
    }

    const status =
      latestPayment
        ? normalizeStatus(
            latestPayment.status
          )
        : null;

    const itemAmount =
      Number(
        item.amount || 0
      );

    // --------------------------------------------
    // คำนวณสถานะ
    // --------------------------------------------

    if (status === 'Approved') {

      // สำคัญ:
      // ไม่รวมยอด Approved ทุกแถว
      // เอาแค่รายการล่าสุดของบิลนี้
      paidTotal +=
        itemAmount;

    } else {

      unpaidTotal +=
        itemAmount;
    }

    if (status === 'Pending') {
      pendingCount++;
    }

    // --------------------------------------------
    // Badge
    // --------------------------------------------

    let statusBadge = '';

    if (status === 'Approved') {

      statusBadge = `
        <span class="fee-badge badge-paid">
          <i class="fa-solid fa-check"></i>
          ชำระแล้ว
        </span>
      `;

    } else if (status === 'Pending') {

      statusBadge = `
        <span class="fee-badge badge-pending">
          <i class="fa-solid fa-clock"></i>
          รอตรวจสอบ
        </span>
      `;

    } else if (status === 'Rejected') {

      statusBadge = `
        <span class="fee-badge badge-unpaid">
          <i class="fa-solid fa-xmark"></i>
          ไม่อนุมัติ / ส่งใหม่
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

    // --------------------------------------------
    // Button
    // --------------------------------------------

    let buttonHtml = '';

    if (status === 'Approved') {

      buttonHtml = `
        <button
          class="btn btn-secondary"
          style="width:100%"
          disabled
        >
          <i class="fa-solid fa-circle-check"></i>
          ชำระเงินแล้ว
        </button>
      `;

    } else if (status === 'Pending') {

      buttonHtml = `
        <button
          class="btn btn-secondary"
          style="width:100%"
          disabled
        >
          <i class="fa-solid fa-clock"></i>
          รอเหรัญญิกตรวจสอบ
        </button>
      `;

    } else {

      const buttonText =
        status === 'Rejected'
          ? 'ส่งสลิปใหม่'
          : 'ชำระเงิน / แนบสลิป';

      buttonHtml = `
        <button
          class="btn btn-primary"
          style="width:100%"
          onclick="openPaymentModal('${escapeJs(item.id)}')"
        >
          <i class="fa-solid fa-qrcode"></i>
          ${buttonText}
        </button>
      `;
    }

    // --------------------------------------------
    // Card
    // --------------------------------------------

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
          ${escapeHtml(
            item.category || ''
          )}
        </div>

        <h4 class="fee-name">
          ${escapeHtml(
            item.name || ''
          )}
        </h4>

        <p class="fee-description">
          ${escapeHtml(
            item.description || ''
          )}
        </p>

      </div>

      <div>

        <div class="fee-meta">

          <div class="fee-amount">

            <span>
              จำนวนเงิน
            </span>

            <strong>
              ฿${itemAmount.toLocaleString()}
            </strong>

          </div>

          <div class="fee-due">

            <i class="fa-regular fa-calendar"></i>

            ครบกำหนด:
            ${escapeHtml(
              item.dueDate || '-'
            )}

          </div>

        </div>

        ${buttonHtml}

      </div>
    `;

    grid.appendChild(
      card
    );
  });

  // --------------------------------------------
  // Stats
  // --------------------------------------------

  setText(
    'statUnpaid',
    `฿${unpaidTotal.toLocaleString()}`
  );

  setText(
    'statPaid',
    `฿${paidTotal.toLocaleString()}`
  );

  setText(
    'statPending',
    `${pendingCount} รายการ`
  );

  renderStudentHistoryTable();
}

// ============================================================
// STUDENT HISTORY
// ============================================================

function renderStudentHistoryTable() {

  const tbody =
    document.getElementById(
      'studentHistoryTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  if (!currentUser) {

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
          กรุณาเข้าสู่ระบบ
        </td>
      </tr>
    `;

    return;
  }

  const userSubs =
    getUserSubmissions();

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

    tr.innerHTML = `

      <td>
        ${escapeHtml(
          sub.timestamp
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
        ฿${Number(
          sub.amount || 0
        ).toLocaleString()}
      </td>

      <td>

        <button
          class="btn btn-secondary btn-sm"
          onclick="viewAdminSlip('${escapeJs(sub.id)}')"
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
                href="${escapeAttribute(sub.slipUrl)}"
                target="_blank"
                rel="noopener"
                class="btn btn-secondary btn-sm"
              >
                <i class="fa-solid fa-external-link"></i>
                เปิด Drive
              </a>
            `
            : '-'
        }

      </td>
    `;

    tbody.appendChild(
      tr
    );
  });
}

// ============================================================
// PROMPTPAY QR
// ============================================================

function generatePromptPayQRPayload(
  target,
  amount
) {

  const sanitize =
    String(target || '')
      .replace(
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
      ? Number(amount).toFixed(2)
      : '0.00';

  const amountLen =
    String(
      amountStr.length
    ).padStart(2, '0');

  let payload =
    `00020101021129370016A000000677010111${targetType}${String(formattedTarget.length).padStart(2, '0')}${formattedTarget}5802TH5303764`;

  if (amount) {

    payload +=
      `54${amountLen}${amountStr}`;
  }

  payload +=
    '6304';

  return payload +
    crc16(payload);
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
      (
        (crc >> 8) ^
        data.charCodeAt(i)
      ) & 0xFF;

    x ^=
      x >> 4;

    crc =
      (
        (crc << 8) ^
        (x << 12) ^
        (x << 5) ^
        x
      ) & 0xFFFF;
  }

  return (
    '0000' +
    crc
      .toString(16)
      .toUpperCase()
  ).slice(-4);
}

// ============================================================
// PAYMENT MODAL
// ============================================================

function openPaymentModal(
  feeId
) {

  if (!currentUser) {

    showToast(
      'กรุณาเข้าสู่ระบบก่อน',
      'error'
    );

    return;
  }

  selectedFeeItem =
    feeItems.find(
      f =>
        String(f.id) ===
        String(feeId)
    );

  if (!selectedFeeItem) {

    showToast(
      'ไม่พบรายการชำระเงิน',
      'error'
    );

    return;
  }

  // --------------------------------------------
  // ป้องกันจ่ายซ้ำ
  // --------------------------------------------

  const userSubs =
    getUserSubmissions();

  const latestMap =
    getLatestPaymentByFee(
      userSubs
    );

  const latest =
    latestMap[
      normalizeFeeKey(
        selectedFeeItem.id
      )
    ] ||
    latestMap[
      normalizeFeeKey(
        selectedFeeItem.name
      )
    ];

  if (latest) {

    const status =
      normalizeStatus(
        latest.status
      );

    if (status === 'Approved') {

      showToast(
        'รายการนี้ชำระแล้ว ไม่สามารถส่งซ้ำได้',
        'info'
      );

      return;
    }

    if (status === 'Pending') {

      showToast(
        'รายการนี้กำลังรอเหรัญญิกตรวจสอบ',
        'info'
      );

      return;
    }
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

function changePaymentQty(
  delta
) {

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
    Number(
      selectedFeeItem.amount ||
      0
    );

  const totalAmount =
    unitPrice *
    currentPaymentQty;

  const qtyValue =
    document.getElementById(
      'qtyValue'
    );

  if (qtyValue) {
    qtyValue.textContent =
      currentPaymentQty;
  }

  const qtyMinus =
    document.getElementById(
      'qtyMinus'
    );

  if (qtyMinus) {
    qtyMinus.disabled =
      currentPaymentQty <= 1;
  }

  const qtyPlus =
    document.getElementById(
      'qtyPlus'
    );

  if (qtyPlus) {
    qtyPlus.disabled =
      currentPaymentQty >= 10;
  }

  const summary =
    document.getElementById(
      'qtySummaryText'
    );

  if (summary) {

    summary.textContent =
      `฿${unitPrice.toLocaleString(
        undefined,
        {
          minimumFractionDigits: 2
        }
      )} × ${currentPaymentQty} = `;
  }

  const summaryTotal =
    document.getElementById(
      'qtySummaryTotal'
    );

  if (summaryTotal) {

    summaryTotal.textContent =
      `฿${totalAmount.toLocaleString(
        undefined,
        {
          minimumFractionDigits: 2
        }
      )}`;
  }

  const modalAmount =
    document.getElementById(
      'modalPromptPayAmount'
    );

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
      function (error) {

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

function closeModal(
  modalId
) {

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

// ============================================================
// SLIP UPLOAD
// ============================================================

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
      e => {

        e.preventDefault();

        dropzone.classList.add(
          'dragover'
        );

      }
    );
  });

  [
    'dragleave',
    'drop'
  ].forEach(eventName => {

    dropzone.addEventListener(
      eventName,
      e => {

        e.preventDefault();

        dropzone.classList.remove(
          'dragover'
        );

      }
    );
  });

  dropzone.addEventListener(
    'drop',
    e => {

      const files =
        e.dataTransfer.files;

      if (
        files &&
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
    files &&
    files.length > 0
  ) {

    processSelectedSlip(
      files[0]
    );
  }
}

function processSelectedSlip(
  file
) {

  if (
    !file ||
    !file.type.startsWith(
      'image/'
    )
  ) {

    showToast(
      'กรุณาเลือกไฟล์รูปภาพสลิปเท่านั้น',
      'error'
    );

    return;
  }

  const reader =
    new FileReader();

  reader.onload =
    function (evt) {

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
          `<i class="fa-solid fa-spinner fa-spin"></i>
           กำลังประมวลผลและบีบอัดรูปภาพ...`;
      }

      const img =
        new Image();

      img.onload =
        function () {

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
                    h *
                    MAX_DIM /
                    w
                  );

                w =
                  MAX_DIM;

              } else {

                w =
                  Math.round(
                    w *
                    MAX_DIM /
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
              typeof jsQR !==
              'undefined'
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

                  scanStatus.innerHTML =
                    `
                    <i
                      class="fa-solid fa-circle-check"
                      style="color:var(--color-success)"
                    ></i>
                    พบ QR Code บนสลิปแล้ว
                    `;
                }

                showToast(
                  'อ่าน QR Code บนสลิปเรียบร้อย',
                  'success'
                );

                return;
              }
            }

          } catch (err) {

            console.warn(
              '[SLIP] Compression/QR:',
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

            scanStatus.innerHTML =
              `
              <i
                class="fa-solid fa-circle-check"
                style="color:var(--color-success)"
              ></i>
              รูปภาพสลิปพร้อมส่งแล้ว
              `;
          }

          showToast(
            'สลิปพร้อมส่งแล้ว',
            'success'
          );
        };

      img.onerror =
        function () {

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
              'รูปภาพสลิปพร้อมส่งแล้ว';
          }
        };

      img.src =
        evt.target.result;
    };

  reader.onerror =
    function () {

      showToast(
        'เกิดข้อผิดพลาดในการอ่านรูปภาพ',
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

  const input =
    document.getElementById(
      'slipInput'
    );

  if (input) {
    input.value = '';
  }

  const preview =
    document.getElementById(
      'slipPreviewBox'
    );

  if (preview) {
    preview.style.display =
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

// ============================================================
// SUBMIT PAYMENT
// ============================================================

async function handlePaymentSubmit(
  e
) {

  e.preventDefault();

  if (!currentSlipBase64) {

    showToast(
      'กรุณาเลือกรูปภาพสลิปก่อนส่ง',
      'info'
    );

    const input =
      document.getElementById(
        'slipInput'
      );

    if (input) {
      input.click();
    }

    return;
  }

  if (
    !currentUser ||
    !currentUser.studentId
  ) {

    showToast(
      'ไม่พบข้อมูลนักศึกษา กรุณาเข้าสู่ระบบใหม่',
      'error'
    );

    return;
  }

  if (!selectedFeeItem) {

    showToast(
      'ไม่พบรายการชำระเงิน',
      'error'
    );

    return;
  }

  // --------------------------------------------
  // เช็กอีกครั้งก่อนส่ง
  // --------------------------------------------

  const userSubs =
    getUserSubmissions();

  const latestMap =
    getLatestPaymentByFee(
      userSubs
    );

  const latest =
    latestMap[
      normalizeFeeKey(
        selectedFeeItem.id
      )
    ] ||
    latestMap[
      normalizeFeeKey(
        selectedFeeItem.name
      )
    ];

  if (latest) {

    const latestStatus =
      normalizeStatus(
        latest.status
      );

    if (
      latestStatus === 'Approved'
    ) {

      showToast(
        'รายการนี้ชำระแล้ว',
        'info'
      );

      return;
    }

    if (
      latestStatus === 'Pending'
    ) {

      showToast(
        'รายการนี้กำลังรอตรวจสอบ',
        'info'
      );

      return;
    }
  }

  const submitBtn =
    document.getElementById(
      'btnSubmitPayment'
    );

  if (submitBtn) {

    submitBtn.disabled =
      true;

    submitBtn.innerHTML =
      `
      <i class="fa-solid fa-spinner fa-spin"></i>
      กำลังบันทึก...
      `;
  }

  const studentName =
    currentUser.name ||
    `นักศึกษา รหัส ${currentUser.studentId}`;

  const studentId =
    String(
      currentUser.studentId
    ).trim();

  const newSubmission = {

    action:
      'submitPayment',

    studentName:
      studentName,

    studentId:
      studentId,

    studentEmail:
      studentId,

    feeId:
      selectedFeeItem.id,

    feeName:
      selectedFeeItem.name,

    amount:
      Number(
        selectedFeeItem.amount
      ) *
      currentPaymentQty,

    status:
      'Pending',

    timestamp:
      new Date().toLocaleString(
        'th-TH'
      ),

    slipBase64:
      currentSlipBase64,

    qrRef:
      currentSlipQRData || '',

    remark:
      document.getElementById(
        'paymentRemark'
      )?.value || '-'
  };

  try {

    if (!CONFIG.GOOGLE_SCRIPT_URL) {

      throw new Error(
        'ยังไม่ได้ตั้งค่า Google Apps Script URL'
      );
    }

    await postToGasReliable(
      newSubmission
    );

    showToast(
      'ส่งสลิปเรียบร้อย! กำลังซิงก์ข้อมูล...',
      'success'
    );

    // --------------------------------------------
    // ไม่ unshift เข้า submissions
    // ป้องกัน duplicate
    // --------------------------------------------

    closeModal(
      'paymentModal'
    );

    resetSlipUploader();

    // --------------------------------------------
    // ดึงข้อมูลจริงจาก Sheet
    // --------------------------------------------

    setTimeout(
      async () => {

        await fetchSubmissionsFromGas();

        renderStudentDashboard();

        if (
          currentView === 'admin'
        ) {
          renderAdminDashboard();
        }

      },
      2500
    );

  } catch (err) {

    console.error(
      '[PAYMENT] Submit error:',
      err
    );

    showToast(
      'ส่งข้อมูลไม่สำเร็จ: ' +
      err.message,
      'error'
    );

    if (submitBtn) {

      submitBtn.disabled =
        false;

      submitBtn.innerHTML =
        `
        <i class="fa-solid fa-paper-plane"></i>
        ยืนยันการส่งสลิป
        `;
    }

    return;
  }

  if (submitBtn) {

    submitBtn.disabled =
      false;

    submitBtn.innerHTML =
      `
      <i class="fa-solid fa-paper-plane"></i>
      ยืนยันการส่งสลิป
      `;
  }
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================

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

  if (
    !feeItems ||
    feeItems.length === 0
  ) {

    tbody.innerHTML =
      `
      <tr>
        <td
          colspan="5"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:1.5rem;
          "
        >
          ยังไม่มีรายการเก็บเงิน
        </td>
      </tr>
      `;

    return;
  }

  feeItems.forEach(
    item => {

      const tr =
        document.createElement(
          'tr'
        );

      tr.innerHTML = `

        <td>
          <strong>
            ${escapeHtml(
              item.name
            )}
          </strong>
        </td>

        <td>
          <span
            style="
              font-size:.8rem;
              color:var(--kmitl-orange);
            "
          >
            ${escapeHtml(
              item.category
            )}
          </span>
        </td>

        <td>
          <strong
            style="
              color:var(--kmitl-gold);
            "
          >
            ฿${Number(
              item.amount || 0
            ).toLocaleString()}
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
              onclick="syncFeeItemToSheet('${escapeJs(item.id)}')"
            >
              <i class="fa-solid fa-cloud-arrow-up"></i>
              ส่งไปชีท
            </button>

            <button
              class="btn btn-danger btn-sm"
              onclick="deleteFeeItem('${escapeJs(item.id)}')"
            >
              <i class="fa-solid fa-trash"></i>
              ลบ
            </button>

          </div>

        </td>
      `;

      tbody.appendChild(
        tr
      );
    }
  );
}

// ============================================================
// ADMIN PAYMENT TABLE
// ============================================================

function renderAdminSubmissionsTable() {

  const tbody =
    document.getElementById(
      'adminSubmissionsTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  if (
    !submissions ||
    submissions.length === 0
  ) {

    tbody.innerHTML =
      `
      <tr>
        <td
          colspan="7"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:2rem;
          "
        >
          ยังไม่มีรายการส่งสลิป
        </td>
      </tr>
      `;

    return;
  }

  submissions.forEach(
    sub => {

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

      const tr =
        document.createElement(
          'tr'
        );

      tr.innerHTML = `

        <td>
          ${escapeHtml(
            sub.timestamp
          )}
        </td>

        <td>

          <div
            style="
              font-weight:600;
            "
          >
            ${escapeHtml(
              sub.studentName
            )}
          </div>

          <div
            style="
              font-size:.775rem;
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
            ฿${Number(
              sub.amount || 0
            ).toLocaleString()}
          </strong>

        </td>

        <td>

          <button
            class="btn btn-secondary btn-sm"
            onclick="viewAdminSlip('${escapeJs(sub.id)}')"
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
              onclick="updateStatus('${escapeJs(sub.id)}','Approved')"
              ${isApproved ? 'disabled' : ''}
            >
              <i class="fa-solid fa-check"></i>
              ${isApproved ? 'อนุมัติแล้ว' : 'อนุมัติ'}
            </button>

            <button
              class="btn btn-danger btn-sm"
              onclick="updateStatus('${escapeJs(sub.id)}','Rejected')"
              ${isRejected ? 'disabled' : ''}
            >
              <i class="fa-solid fa-xmark"></i>
              ${isRejected ? 'ปฏิเสธแล้ว' : 'ไม่อนุมัติ'}
            </button>

          </div>

        </td>
      `;

      tbody.appendChild(
        tr
      );
    }
  );
}

// ============================================================
// VIEW SLIP
// ============================================================

function viewAdminSlip(
  subId
) {

  const sub =
    submissions.find(
      s =>
        String(s.id) ===
        String(subId)
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
      sub.slipUrl ||
      'https://via.placeholder.com/400x500?text=Slip+Image';
  }

  if (metaBox) {

    metaBox.innerHTML = `

      <div>
        <strong>ชื่อผู้โอน:</strong>
        ${escapeHtml(
          sub.studentName
        )}
        (${escapeHtml(
          sub.studentId ||
          sub.studentEmail ||
          ''
        )})
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
          sub.timestamp
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
              <strong>QR Payload:</strong>
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
        ? 'inline-flex'
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

// ============================================================
// UPDATE PAYMENT STATUS
// ============================================================

async function updateStatus(
  subId,
  newStatus
) {

  const sub =
    submissions.find(
      s =>
        String(s.id) ===
        String(subId)
    );

  if (!sub) {

    showToast(
      'ไม่พบรายการชำระเงิน',
      'error'
    );

    return;
  }

  const normalized =
    normalizeStatus(
      newStatus
    );

  // --------------------------------------------
  // ถ้าสถานะเหมือนเดิม ไม่ต้องยิงซ้ำ
  // --------------------------------------------

  if (
    normalizeStatus(
      sub.status
    ) === normalized
  ) {

    showToast(
      'รายการนี้มีสถานะนี้อยู่แล้ว',
      'info'
    );

    return;
  }

  // --------------------------------------------
  // Update local ทันที
  // --------------------------------------------

  sub.status =
    normalized;

  localStorage.setItem(
    'kmitl_pay_submissions',
    JSON.stringify(
      submissions
    )
  );

  renderAdminDashboard();

  if (currentUser) {
    renderStudentDashboard();
  }

  showToast(
    normalized === 'Approved'
      ? 'กำลังอนุมัติรายการ...'
      : 'กำลังปฏิเสธรายการ...',
    'info'
  );

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'ไม่มี Google Apps Script URL',
      'error'
    );

    return;
  }

  try {

    const rowNumber =
      Number(
        sub.rowNumber ||
        (
          String(sub.id)
            .startsWith('gas-')
            ? String(sub.id)
                .replace(
                  'gas-',
                  ''
                )
            : 0
        )
      ) || 0;

    // --------------------------------------------
    // ยิง POST เพียงครั้งเดียว
    // ห้ามยิง GET ซ้ำ
    // --------------------------------------------

    await postToGasReliable({

      action:
        'updatePaymentStatus',

      studentId:
        sub.studentId ||
        sub.studentEmail ||
        '',

      studentName:
        sub.studentName ||
        '',

      feeName:
        sub.feeName ||
        '',

      status:
        normalized,

      amount:
        Number(
          sub.amount || 0
        ),

      rowNumber:
        rowNumber
    });

    showToast(
      normalized === 'Approved'
        ? 'อนุมัติการชำระเงินแล้ว 🟢'
        : 'ปฏิเสธการชำระเงินแล้ว',
      normalized === 'Approved'
        ? 'success'
        : 'info'
    );

    // --------------------------------------------
    // ดึงข้อมูลจริงกลับจาก Sheet
    // --------------------------------------------

    setTimeout(
      async () => {

        await fetchSubmissionsFromGas();

        renderAdminDashboard();

        if (currentUser) {
          renderStudentDashboard();
        }

      },
      2000
    );

  } catch (err) {

    console.error(
      '[ADMIN] Update status error:',
      err
    );

    showToast(
      'อัปเดตสถานะไม่สำเร็จ: ' +
      err.message,
      'error'
    );

    // ดึงข้อมูลจริงกลับ
    // เพื่อ rollback local
    await fetchSubmissionsFromGas();
  }
}

// ============================================================
// ADMIN SYNC
// ============================================================

async function syncAllAdminData() {

  const btn =
    document.getElementById(
      'btnSyncAllData'
    );

  if (btn) {

    btn.disabled =
      true;

    btn.innerHTML =
      `
      <i class="fa-solid fa-spinner fa-spin"></i>
      กำลังซิงก์ข้อมูล...
      `;
  }

  showToast(
    'กำลังซิงก์ข้อมูลกับ Google Sheet...',
    'info'
  );

  try {

    await fetchSubmissionsFromGas();

    await fetchFeeItemsFromGas();

    showToast(
      'ซิงก์ข้อมูลสำเร็จแล้ว 🟢',
      'success'
    );

  } catch (err) {

    console.warn(
      '[SYNC] Error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการซิงก์',
      'error'
    );

  } finally {

    if (btn) {

      btn.disabled =
        false;

      btn.innerHTML =
        `
        <i class="fa-solid fa-floppy-disk"></i>
        บันทึก & ซิงก์ข้อมูล Google Sheet
        `;
    }
  }
}

// ============================================================
// CREATE FEE
// ============================================================

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

async function handleCreateFeeSubmit(
  e
) {

  e.preventDefault();

  const category =
    getInputValue(
      'newFeeCategory'
    );

  const name =
    getInputValue(
      'newFeeName'
    );

  const desc =
    getInputValue(
      'newFeeDesc'
    );

  const amount =
    parseFloat(
      getInputValue(
        'newFeeAmount'
      )
    );

  const dueDate =
    getInputValue(
      'newFeeDueDate'
    ) ||
    '2026-08-31';

  if (
    !name ||
    !amount ||
    amount <= 0
  ) {

    showToast(
      'กรุณากรอกข้อมูลรายการให้ครบ',
      'error'
    );

    return;
  }

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

  [
    'newFeeCategory',
    'newFeeName',
    'newFeeDesc',
    'newFeeAmount'
  ].forEach(id => {

    const el =
      document.getElementById(
        id
      );

    if (el) {
      el.value = '';
    }
  });

  renderStudentDashboard();
  renderAdminDashboard();

  showToast(
    'เพิ่มรายการเก็บเงินแล้ว',
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
        'ซิงก์รายการลง Google Sheet แล้ว 🟢',
        'success'
      );

    } catch (err) {

      console.warn(
        '[FEE] Sync error:',
        err
      );
    }
  }
}

// ============================================================
// DELETE FEE
// ============================================================

async function deleteFeeItem(
  feeId
) {

  const itemToDelete =
    feeItems.find(
      f =>
        String(f.id) ===
        String(feeId)
    );

  if (!itemToDelete) {
    return;
  }

  if (
    !confirm(
      'คุณต้องการลบรายการเก็บเงินนี้ใช่หรือไม่?'
    )
  ) {
    return;
  }

  feeItems =
    feeItems.filter(
      f =>
        String(f.id) !==
        String(feeId)
    );

  saveFeeItemsToStorage();

  renderAdminDashboard();

  if (currentUser) {
    renderStudentDashboard();
  }

  showToast(
    'ลบรายการเก็บเงินแล้ว',
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
          itemToDelete.name
      });

      showToast(
        'ลบออกจาก Google Sheet แล้ว 🟢',
        'success'
      );

    } catch (err) {

      console.warn(
        '[FEE] Delete sync error:',
        err
      );
    }
  }
}

// ============================================================
// SYNC FEE
// ============================================================

async function syncFeeItemToSheet(
  feeId
) {

  const item =
    feeItems.find(
      f =>
        String(f.id) ===
        String(feeId)
    );

  if (!item) {
    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'กรุณาตั้งค่า Google Apps Script ก่อน',
      'error'
    );

    return;
  }

  showToast(
    'กำลังส่งรายการไป Google Sheet...',
    'info'
  );

  try {

    // ลบของเก่าก่อน
    try {

      await postToGasReliable({

        action:
          'deleteFeeItem',

        feeId:
          feeId,

        feeName:
          item.name
      });

    } catch (e) {}

    await postToGasReliable({

      action:
        'saveFeeItem',

      feeItem:
        item
    });

    showToast(
      'ส่งรายการไป Google Sheet สำเร็จ 🟢',
      'success'
    );

  } catch (err) {

    console.warn(
      '[FEE] Sync error:',
      err
    );

    showToast(
      'ส่งข้อมูลไป Google Sheet ไม่สำเร็จ',
      'error'
    );
  }
}

// ============================================================
// CONFIG MODAL
// ============================================================

function openConfigModal() {

  setInputValue(
    'cfgScriptUrl',
    CONFIG.GOOGLE_SCRIPT_URL || ''
  );

  setInputValue(
    'cfgLineChannelId',
    CONFIG.LINE_CHANNEL_ID || ''
  );

  setInputValue(
    'cfgLineChannelSecret',
    CONFIG.LINE_CHANNEL_SECRET || ''
  );

  setInputValue(
    'cfgPromptPay',
    CONFIG.PROMPTPAY_NUMBER || ''
  );

  setInputValue(
    'cfgPromptPayName',
    CONFIG.PROMPTPAY_NAME || ''
  );

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

async function handleSaveConfig(
  e
) {

  e.preventDefault();

  CONFIG.GOOGLE_SCRIPT_URL =
    getInputValue(
      'cfgScriptUrl'
    );

  CONFIG.LINE_CHANNEL_ID =
    getInputValue(
      'cfgLineChannelId'
    );

  CONFIG.LINE_CHANNEL_SECRET =
    getInputValue(
      'cfgLineChannelSecret'
    );

  CONFIG.PROMPTPAY_NUMBER =
    getInputValue(
      'cfgPromptPay'
    );

  CONFIG.PROMPTPAY_NAME =
    getInputValue(
      'cfgPromptPayName'
    );

  saveConfigToStorage();

  closeModal(
    'configModal'
  );

  showToast(
    'บันทึกการตั้งค่าแล้ว',
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
        'ซิงก์การตั้งค่าลง Google Sheet แล้ว 🟢',
        'success'
      );

    } catch (err) {

      console.warn(
        '[CONFIG] Sync error:',
        err
      );
    }
  }
}

// ============================================================
// SYSTEM CONFIG
// ============================================================

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

      if (
        result.data.PROMPTPAY_NUMBER
      ) {

        CONFIG.PROMPTPAY_NUMBER =
          result.data.PROMPTPAY_NUMBER;
      }

      if (
        result.data.PROMPTPAY_NAME
      ) {

        CONFIG.PROMPTPAY_NAME =
          result.data.PROMPTPAY_NAME;
      }

      localStorage.setItem(
        'kmitl_pay_config',
        JSON.stringify(
          CONFIG
        )
      );
    }

  } catch (err) {

    console.warn(
      '[CONFIG] Fetch error:',
      err
    );
  }
}

// ============================================================
// PROMPTPAY MASK
// ============================================================

function maskPromptPay(
  number
) {

  if (!number) {
    return '';
  }

  const str =
    String(number)
      .trim();

  if (
    str.length === 10
  ) {

    return (
      str.substring(0, 3) +
      '-xxx-' +
      str.substring(6)
    );
  }

  if (
    str.length === 13
  ) {

    return (
      str.substring(0, 4) +
      '-xxxxx-xxx-' +
      str.substring(12)
    );
  }

  if (
    str.length > 4
  ) {

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

  return str;
}

// ============================================================
// TOAST
// ============================================================

function showToast(
  message,
  type = 'info'
) {

  const container =
    document.getElementById(
      'toastContainer'
    );

  if (!container) {

    console.log(
      `[${type}]`,
      message
    );

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

  toast.innerHTML =
    `
    <i class="fa-solid ${icon}"></i>
    <span>
      ${escapeHtml(message)}
    </span>
    `;

  container.appendChild(
    toast
  );

  setTimeout(
    () => {

      toast.style.opacity =
        '0';

      setTimeout(
        () => {

          if (toast) {
            toast.remove();
          }

        },
        300
      );

    },
    3500
  );
}

// ============================================================
// ESCAPE HELPERS
// ============================================================

function escapeHtml(
  str
) {

  if (
    str === null ||
    str === undefined
  ) {
    return '';
  }

  return String(str)
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

function escapeAttribute(
  value
) {

  return escapeHtml(
    value
  );
}

function escapeJs(
  value
) {

  return String(
    value || ''
  )
    .replace(
      /\\/g,
      '\\\\'
    )
    .replace(
      /'/g,
      "\\'"
    )
    .replace(
      /"/g,
      '\\"'
    );
}

// ============================================================
// DOM HELPERS
// ============================================================

function setText(
  id,
  value
) {

  const el =
    document.getElementById(
      id
    );

  if (el) {
    el.textContent =
      value;
  }
}

function getInputValue(
  id
) {

  const el =
    document.getElementById(
      id
    );

  return el
    ? String(
        el.value || ''
      ).trim()
    : '';
}

function setInputValue(
  id,
  value
) {

  const el =
    document.getElementById(
      id
    );

  if (el) {
    el.value =
      value;
  }
}

// ============================================================
// RELIABLE POST TO GOOGLE APPS SCRIPT
// ============================================================

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

  const params =
    new URLSearchParams();

  for (
    const key in data
  ) {

    if (
      key === 'slipBase64'
    ) {
      continue;
    }

    if (
      data[key] === null ||
      data[key] === undefined
    ) {
      continue;
    }

    if (
      typeof data[key] ===
      'object'
    ) {
      continue;
    }

    const value =
      String(data[key]);

    if (
      value.length < 300
    ) {

      params.append(
        key,
        value
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
    JSON.stringify(
      data
    );

  console.log(
    '[GAS POST]',
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

    return {
      status:
        'success'
    };

  } catch (err) {

    console.warn(
      '[GAS POST] Fetch failed, using fallback:',
      err
    );

    return sendViaHiddenForm(
      gasUrl,
      data
    );
  }
}

// ============================================================
// HIDDEN FORM FALLBACK
// ============================================================

function sendViaHiddenForm(
  url,
  data
) {

  return new Promise(
    resolve => {

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
          JSON.stringify(
            data
          );

        form.appendChild(
          input
        );

        document.body.appendChild(
          form
        );

        form.submit();

        setTimeout(
          () => {

            form.remove();

            resolve({
              status:
                'success',

              fallback:
                true
            });

          },
          1500
        );

      } catch (err) {

        console.error(
          '[GAS FALLBACK]',
          err
        );

        resolve({
          status:
            'error',

          message:
            err.message
        });
      }
    }
  );
}

// ============================================================
// GOOGLE SIGN-IN CALLBACK
// ============================================================

async function handleGoogleSignIn(
  response
) {

  if (!response || !response.credential) {

    showToast(
      'ไม่พบข้อมูลจาก Google',
      'error'
    );

    return;
  }

  try {

    // ถ้ามี Apps Script endpoint สำหรับ Google Login
    // ส่ง credential ไปตรวจสอบฝั่ง server

    if (!CONFIG.GOOGLE_SCRIPT_URL) {

      showToast(
        'ยังไม่ได้ตั้งค่า Google Apps Script',
        'error'
      );

      return;
    }

    const result =
      await postToGasReliable({

        action:
          'googleLogin',

        credential:
          response.credential
      });

    console.log(
      '[GOOGLE LOGIN]',
      result
    );

    /*
     * ถ้า backend รุ่นปัจจุบันไม่ได้รองรับ googleLogin
     * จะไม่สร้าง session ปลอมให้เอง
     */

    showToast(
      'ได้รับข้อมูล Google แล้ว กรุณาใช้ระบบตรวจสอบบัญชีของเซิร์ฟเวอร์',
      'info'
    );

  } catch (err) {

    console.error(
      '[GOOGLE LOGIN]',
      err
    );

    showToast(
      'เข้าสู่ระบบ Google ไม่สำเร็จ',
      'error'
    );
  }
}
