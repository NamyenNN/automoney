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
 */

// Default Fee Items List
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

// Default Configuration
let CONFIG = JSON.parse(localStorage.getItem('kmitl_pay_config')) || {};

if (!CONFIG.GOOGLE_SCRIPT_URL) {
  CONFIG.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw_OxjIFz_N6wJzF_fFhoJE6P561_jBoWMs8WDO9q8b1RsnYdaDtormoQnupF1oHQ8J/exec';
}
CONFIG.LINE_CHANNEL_ID = CONFIG.LINE_CHANNEL_ID || '2010801650';
CONFIG.LINE_CHANNEL_SECRET = CONFIG.LINE_CHANNEL_SECRET || '832a75e287353de9a597989d0f23761e';
CONFIG.LIFF_ID = CONFIG.LIFF_ID || '2010801650-te43AoZe';

if (!CONFIG.PROMPTPAY_NUMBER) CONFIG.PROMPTPAY_NUMBER = '0891234567';
if (!CONFIG.PROMPTPAY_NAME) CONFIG.PROMPTPAY_NAME = 'เหรัญญิกประจำห้อง (KMITL Pay)';
if (CONFIG.ALLOW_NON_KMITL_IN_DEMO === undefined) CONFIG.ALLOW_NON_KMITL_IN_DEMO = false;

localStorage.setItem('kmitl_pay_config', JSON.stringify(CONFIG));

// Initial State Data
let currentUser = null;
let currentView = 'student'; // 'student' or 'admin'
let selectedFeeItem = null;
let currentSlipBase64 = null;
let currentSlipQRData = null;

// Fee Items (Loaded from LocalStorage to persist across reloads)
let feeItems = JSON.parse(localStorage.getItem('kmitl_pay_fee_items')) || DEFAULT_FEE_ITEMS;

// Submissions List (Loaded live from Google Sheet)
let submissions = JSON.parse(localStorage.getItem('kmitl_pay_submissions')) || [];

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  setupDragAndDrop();
  checkGasConfigAlert();

  // ==========================================
  // ADMIN PAGE
  // ==========================================
  if (
    window.location.pathname
      .toLowerCase()
      .includes('admin.html')
  ) {
    currentView = 'admin';

    await Promise.allSettled([
      fetchSubmissionsFromGas(),
      fetchFeeItemsFromGas(),
      fetchSystemConfigFromGas()
    ]);

    renderAdminDashboard();
    return;
  }

  // ==========================================
  // RESTORE SAVED SESSION FIRST
  // ==========================================
  const restored = checkSavedSession();

  if (restored) {
    console.log(
      '[Session] Existing session restored'
    );

    // โหลดข้อมูลจาก Google Sheet เบื้องหลัง
    await Promise.allSettled([
      fetchSubmissionsFromGas(),
      fetchFeeItemsFromGas(),
      fetchSystemConfigFromGas()
    ]);

    return;
  }

  // ==========================================
  // NO LOCAL SESSION
  // TRY LIFF AUTO LOGIN
  // ==========================================
  const liffLoggedIn =
    await checkLiffAutoLogin();

  if (liffLoggedIn) {
    await Promise.allSettled([
      fetchSubmissionsFromGas(),
      fetchFeeItemsFromGas(),
      fetchSystemConfigFromGas()
    ]);

    return;
  }

  // ==========================================
  // NO SESSION
  // SHOW LOGIN
  // ==========================================
  showLoginScreen();

  await Promise.allSettled([
    fetchSubmissionsFromGas(),
    fetchFeeItemsFromGas(),
    fetchSystemConfigFromGas()
  ]);

  checkLineAuthCode();
});

// ==========================================
// SECONDARY INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  initGoogleSignIn();
});

function normalizeStatus(st) {
  if (!st) return 'Pending';
  const str = st.toString().trim().toLowerCase();
  if (str.includes('approved') || str.includes('อนุมัติ') || str.includes('ชำระแล้ว') || str.includes('paid')) {
    return 'Approved';
  }
  if (str.includes('reject') || str.includes('ปฏิเสธ') || str.includes('ไม่อนุมัติ')) {
    return 'Rejected';
  }
  return 'Pending';
}

async function fetchSubmissionsFromGas() {
  if (!CONFIG.GOOGLE_SCRIPT_URL) return;
  try {
    const url = CONFIG.GOOGLE_SCRIPT_URL + (CONFIG.GOOGLE_SCRIPT_URL.includes('?') ? '&' : '?') + 'action=getPayments&t=' + Date.now();
    const response = await fetch(url);
    const result = await response.json();
    if (result && result.status === 'success' && Array.isArray(result.data)) {
      const sheetSubmissions = result.data.map((row, idx) => ({
        id: 'gas-' + idx,
        timestamp: row['วันเวลาที่ส่ง'] ? row['วันเวลาที่ส่ง'].toString() : '',
        studentName: row['ชื่อ-นามสกุล'] ? row['ชื่อ-นามสกุล'].toString() : '',
        studentEmail: row['ข้อมูลประจำตัว/รหัส'] ? row['ข้อมูลประจำตัว/รหัส'].toString() : '',
        feeName: row['รายการชำระเงิน'] ? row['รายการชำระเงิน'].toString() : '',
        amount: parseFloat(row['จำนวนเงิน (บาท)']) || 0,
        status: row['สถานะ'] ? normalizeStatus(row['สถานะ']) : 'Pending',
        slipUrl: row['ลิงก์สลิปใน Google Drive'] ? row['ลิงก์สลิปใน Google Drive'].toString() : 'https://drive.google.com/drive/folders/1vVmoWgVS3V0ASdY3TYhSY76kgFYjBV57',
        qrRef: row['ข้อมูล QR Ref บนสลิป'] ? row['ข้อมูล QR Ref บนสลิป'].toString() : '',
        remark: row['หมายเหตุ'] ? row['หมายเหตุ'].toString() : ''
      }));
      submissions = sheetSubmissions;
      localStorage.setItem('kmitl_pay_submissions', JSON.stringify(submissions));
      if (currentView === 'admin') renderAdminDashboard();
    }
  } catch (err) {
    console.warn('Fetch submissions error:', err);
  }
}

async function fetchFeeItemsFromGas() {
  if (!CONFIG.GOOGLE_SCRIPT_URL) return;
  try {
    const url = CONFIG.GOOGLE_SCRIPT_URL + (CONFIG.GOOGLE_SCRIPT_URL.includes('?') ? '&' : '?') + 'action=getFeeItems&t=' + Date.now();
    const response = await fetch(url);
    const result = await response.json();
    if (result && result.status === 'success' && Array.isArray(result.data)) {
      const cloudItems = result.data.map(item => {
        let cleanDueDate = item.dueDate ? item.dueDate.toString() : '';
        if (cleanDueDate.includes('GMT') || cleanDueDate.includes('T')) {
          try {
            const d = new Date(cleanDueDate);
            cleanDueDate = d.toISOString().split('T')[0];
          } catch(e) {}
        }
        return {
          id: item.id || ('fee-' + Date.now()),
          category: item.category || 'ค่าห้อง',
          name: item.name || '',
          description: item.description || '',
          amount: parseFloat(item.amount) || 0,
          dueDate: cleanDueDate
        };
      });

      // Overwrite local items with cloud items to ensure deletions sync to everyone
      feeItems = cloudItems;
      saveFeeItemsToStorage();
      renderStudentDashboard();
      renderAdminDashboard();
    }
  } catch (err) {
    console.warn('Fetch fee items error:', err);
  }
}

// ==========================================
// LIFF AUTO LOGIN
// ==========================================
async function checkLiffAutoLogin() {

  // ถ้าผู้ใช้เพิ่งกด Logout
  // ห้าม LIFF login กลับอัตโนมัติ
  if (
    sessionStorage.getItem(
      'kmitl_pay_manual_logout'
    ) === '1'
  ) {
    console.log(
      '[LIFF] Auto login skipped - manual logout'
    );

    return false;
  }

  // ถ้ามี currentUser แล้ว
  // ไม่ต้อง login ซ้ำ
  if (currentUser) {
    console.log(
      '[LIFF] Auto login skipped - currentUser exists'
    );

    return true;
  }

  if (
    !CONFIG.LIFF_ID ||
    typeof liff === 'undefined'
  ) {
    console.log(
      '[LIFF] LIFF is not available'
    );

    return false;
  }

  try {
    await liff.init({
      liffId:
        CONFIG.LIFF_ID
    });

    console.log(
      '[LIFF] Initialized'
    );

    if (
      typeof liff.isLoggedIn ===
        'function' &&
      liff.isLoggedIn()
    ) {
      console.log(
        '[LIFF] User is logged in'
      );

      const profile =
        await liff.getProfile();

      if (profile) {
        await processLiffProfile(
          profile
        );

        return !!currentUser;
      }
    }

  } catch (err) {
    console.warn(
      '[LIFF] Auto-login check failed:',
      err
    );
  }

  return false;
}

// ==========================================
// SAVE USER SESSION
// ==========================================
function saveUserSession(userData) {
  if (!userData) {
    console.warn(
      '[Session] Cannot save empty user'
    );

    return;
  }

  currentUser =
    userData;

  localStorage.setItem(
    'kmitl_pay_user',
    JSON.stringify(userData)
  );

  // Login สำเร็จ → ล้างสถานะ manual logout
  sessionStorage.removeItem(
    'kmitl_pay_manual_logout'
  );

  console.log(
    '[Session] Saved user:',
    userData
  );
}

// ==========================================
// LOGOUT
// ==========================================
function logoutUser() {
  currentUser = null;

  // ลบ Web session
  localStorage.removeItem(
    'kmitl_pay_user'
  );

  // ป้องกัน LIFF login กลับทันที
  sessionStorage.setItem(
    'kmitl_pay_manual_logout',
    '1'
  );

  // Logout จาก LIFF
  try {
    if (
      typeof liff !== 'undefined' &&
      typeof liff.isLoggedIn ===
        'function' &&
      liff.isLoggedIn() &&
      typeof liff.logout ===
        'function'
    ) {
      liff.logout();
    }
  } catch (e) {
    console.warn(
      '[LIFF] Logout warning:',
      e
    );
  }

  showLoginScreen();

  showToast(
    'ออกจากระบบเรียบร้อยแล้ว',
    'info'
  );
}

// Initialize Dynamic Google Sign-In
function initGoogleSignIn() {
  const btnContainer = document.getElementById("g_id_signin_dynamic");
  const noteEl = document.getElementById("googleSignInNote");
  
  if (!btnContainer) return;
  btnContainer.innerHTML = ''; // Clear previous button

  if (!CONFIG.GOOGLE_CLIENT_ID) {
    if (noteEl) noteEl.style.display = 'block';
    return;
  }

  if (noteEl) noteEl.style.display = 'none';

  // Render Google GSI Button dynamically
  setTimeout(() => {
    if (typeof google !== 'undefined') {
      try {
        google.accounts.id.initialize({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          callback: handleGoogleSignIn,
          context: 'signin',
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true
        });
        
        google.accounts.id.renderButton(btnContainer, {
          type: "standard",
          shape: "rectangular",
          theme: "filled_blue",
          text: "signin_with",
          size: "large",
          logo_alignment: "left"
        });
      } catch (err) {
        console.error('Google Sign-in rendering error:', err);
      }
    }
  }, 500);
}

function saveFeeItemsToStorage() {
  localStorage.setItem('kmitl_pay_fee_items', JSON.stringify(feeItems));
}

function saveConfigToStorage() {
  localStorage.setItem('kmitl_pay_config', JSON.stringify(CONFIG));
  checkGasConfigAlert();
}

function checkGasConfigAlert() {
  const alertBox = document.getElementById('gasStatusAlert');
  if (!alertBox) return;

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    alertBox.style.display = 'block';
    alertBox.innerHTML = `
      <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); color: var(--color-warning); padding: 12px 16px; border-radius: 12px; font-size: 0.875rem; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <i class="fa-solid fa-triangle-exclamation"></i> <strong>ยังไม่ได้ระบุ Google Apps Script Web App URL:</strong> ระบบกำลังทำงานในโหมดสาธิต (ข้อมูลจะถูกเซฟในเบราว์เซอร์ชั่วคราว) 
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">ตั้งค่าตอนนี้</button>
      </div>
    `;
  } else {
    alertBox.style.display = 'block';
    alertBox.innerHTML = `
      <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: var(--color-success); padding: 12px 16px; border-radius: 12px; font-size: 0.875rem; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <i class="fa-solid fa-circle-check"></i> <strong>เชื่อมต่อ Google Apps Script เรียบร้อย:</strong> ข้อมูลสลิปและประวัติจะถูกส่งตรงเข้า Google Sheet & Google Drive
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">แก้ไขตั้งค่า</button>
      </div>
    `;
  }
}

// ==========================================
// REMEMBER LOGIN
// ==========================================
function checkSavedSession() {
  const savedUser =
    localStorage.getItem('kmitl_pay_user');

  console.log(
    '[Session] Checking saved session:',
    savedUser
  );

  if (savedUser) {
    try {
      const user =
        JSON.parse(savedUser);

      if (
        user &&
        (
          user.studentId ||
          user.name ||
          user.lineUserId
        )
      ) {
        currentUser = user;

        console.log(
          '[Session] Restored user:',
          currentUser
        );

        showMainApplication(
          currentUser
        );

        showToast(
          `ต้อนรับกลับ, ${
            currentUser.name ||
            'นักศึกษา'
          }`,
          'info'
        );

        return true;
      }

    } catch (e) {
      console.warn(
        '[Session] Invalid saved session:',
        e
      );

      localStorage.removeItem(
        'kmitl_pay_user'
      );
    }
  }

  showLoginScreen();

  return false;
}

// ==========================================
// SHOW LOGIN SCREEN
// ==========================================
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

  const navAdminLink =
    document.getElementById(
      'navAdminLink'
    );

  if (navAdminLink) {
    navAdminLink.style.display =
      'none';
  }
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
    uri = uri.slice(0, -1);
  }

  return uri;
}

// ==========================================
// AUTHENTICATION & LOGIN LOGIC
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  checkLineAuthCode();
  fetchSystemConfigFromGas();
});

function checkLineAuthCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (code) {
    // Clean URL parameter so refresh doesn't trigger code exchange again
    window.history.replaceState({}, document.title, window.location.pathname);
    processLineLogin(code);
  }
}

function getRedirectUri() {
  let uri = window.location.origin + window.location.pathname;
  if (uri.length > 1 && uri.endsWith('/')) {
    uri = uri.slice(0, -1);
  }
  return uri;
}

// ==========================================
// LINE LOGIN & BYPASS LOGIN LOGIC (LIFF + OAUTH)
// ==========================================
async function loginWithLine() {
  // Option 1: Native LINE LIFF (Fastest, 100% Reliable for Mobile & Desktop)
  if (CONFIG.LIFF_ID && typeof liff !== 'undefined') {
    showToast('กำลังเชื่อมต่อ LINE...', 'info');
    try {
      if (typeof liff.init === 'function') {
        await liff.init({ liffId: CONFIG.LIFF_ID });
      }
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return;
      }
      const profile = await liff.getProfile();
      await processLiffProfile(profile);
      return;
    } catch (err) {
      console.warn('LIFF init failed, falling back to standard LINE OAuth:', err);
    }
  }

  // Option 2: Standard LINE OAuth Redirect
  if (!CONFIG.LINE_CHANNEL_ID) {
    showToast('กรุณากรอก LINE Channel ID หรือ LIFF ID ในแผงเหรัญญิกก่อนใช้งานระบบนี้', 'error');
    return;
  }
  
  const redirectUri = encodeURIComponent(getRedirectUri());
  const state = 'state-' + Date.now();
  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${CONFIG.LINE_CHANNEL_ID}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid`;
  
  window.location.href = authUrl;
}

// Process LIFF User Profile directly
async function processLiffProfile(profile) {
  const lineUserId = profile.userId;
  const lineName = profile.displayName || 'LINE User';
  const picture = profile.pictureUrl || '';

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL', 'error');
    return;
  }

  showToast('กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...', 'info');

  try {
    const url = `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkLineUser&lineUserId=${encodeURIComponent(lineUserId)}`;
    const response = await fetch(url);
    const result = await response.json();

    if (result && result.status === 'success') {
      if (result.registered) {
        const userData = {
          lineUserId: lineUserId,
          name: result.name,
          studentId: result.studentId,
          picture: picture
        };
        saveUserSession(userData);
        showMainApplication(userData);
        showToast(`ยินดีต้อนรับกลับ คุณ ${userData.name}!`, 'success');
      } else {
        showRegistrationScreen(lineUserId, lineName);
      }
    } else {
      showToast(result.message || 'ไม่สามารถตรวจสอบข้อมูลกับเซิร์ฟเวอร์ได้', 'error');
    }
  } catch (err) {
    console.error('LIFF Profile Check Error:', err);
    showToast('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์', 'error');
  }
}

// Direct Login: Strict verification against Google Sheets database
async function handleDirectStudentLogin(e) {
  e.preventDefault();
  const studentId = document.getElementById('loginStudentIdInput').value.trim();
  if (!studentId) return;

  // Verify strictly against Google Sheets database if configured
  if (CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...', 'info');
    try {
      const response = await fetch(`${CONFIG.GOOGLE_SCRIPT_URL}?action=checkStudentId&studentId=${encodeURIComponent(studentId)}`);
      const result = await response.json();
      
      if (result && result.status === 'success' && result.exists) {
        const userData = {
          studentId: studentId,
          name: result.name || ('นักศึกษา รหัส ' + studentId),
          email: 'direct_login',
          picture: ''
        };
        saveUserSession(userData);
        showMainApplication(userData);
        showToast(`ยินดีต้อนรับคุณ ${userData.name}!`, 'success');
      } else {
        // STRICT BLOCK: ID is not found in the official Sheet database
        showToast(`ไม่พบรหัสนักศึกษา ${studentId} ในตารางรายชื่อห้องเรียนที่เป็นทางการ!`, 'error');
      }
    } catch (err) {
      console.warn('Apps Script direct login check failed:', err);
      showToast('ไม่สามารถเชื่อมต่อตรวจสอบรายชื่อใน Google Sheet ได้', 'error');
    }
  } else {
    showToast('กรุณาตั้งค่า Google Apps Script Web App URL ในแผงเหรัญญิกก่อน', 'error');
  }
}

function mockLocalLogin(studentId) {
  const userData = {
    studentId: studentId,
    name: 'นักศึกษา รหัส ' + studentId,
    email: 'direct_login',
    picture: ''
  };
  saveUserSession(userData);
  showMainApplication(userData);
  showToast('เข้าสู่ระบบสำเร็จ (โหมดสาธิต)', 'success');
}

// Process the authorization code returned from LINE
async function processLineLogin(code) {
  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL', 'error');
    return;
  }

  showToast('กำลังเข้าสู่ระบบผ่าน LINE...', 'info');

  try {
    const redirectUri = getRedirectUri();
    const url = `${CONFIG.GOOGLE_SCRIPT_URL}?action=lineLogin&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}&channelId=${CONFIG.LINE_CHANNEL_ID}&channelSecret=${CONFIG.LINE_CHANNEL_SECRET}`;
    
    const response = await fetch(url);
    const result = await response.json();

    if (result && result.status === 'success') {
      if (result.registered) {
        // Log in immediately if already linked
        const userData = {
          lineUserId: result.lineUserId,
          name: result.name,
          studentId: result.studentId,
          picture: result.picture || ''
        };
        saveUserSession(userData);
        showMainApplication(userData);
        showToast(`ยินดีต้อนรับกลับ คุณ ${userData.name}!`, 'success');
      } else {
        // Show registration / linking form
        showRegistrationScreen(result.lineUserId, result.lineName);
      }
    } else {
      showToast(result.message || 'แลกเปลี่ยนรหัสโทเค็น LINE ไม่สำเร็จ', 'error');
    }
  } catch (err) {
    console.error('LINE Code Exchange Error:', err);
    showToast('เกิดข้อผิดพลาดในการเชื่อมต่อ LINE Server', 'error');
  }
}

function showRegistrationScreen(lineUserId, lineName) {
  currentUser = { lineUserId: lineUserId, lineName: lineName }; // Store temporarily
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'none';
  document.getElementById('registerSection').style.display = 'block';
  document.getElementById('registerLineNameText').textContent = lineName;
  document.getElementById('registerStudentId').value = '';
}

async function handleRegistrationSubmit(e) {
  e.preventDefault();
  const studentId = document.getElementById('registerStudentId').value.trim();
  const lineUserId = currentUser.lineUserId;
  const lineName = currentUser.lineName;

  if (!studentId) {
    showToast('กรุณากรอกรหัสนักศึกษา', 'error');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจสอบรหัสในฐานข้อมูล...`;

  try {
    let studentName = lineName || ('นักศึกษา รหัส ' + studentId);
    if (CONFIG.GOOGLE_SCRIPT_URL) {
      try {
        const response = await fetch(CONFIG.GOOGLE_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'registerLineUser',
            lineUserId: lineUserId,
            studentId: studentId,
            lineName: lineName
          })
        });
        const result = await response.json();
        if (result && result.status === 'success' && result.name) {
          studentName = result.name;
        }
      } catch (e) {
        console.warn('LINE POST registration warning:', e);
      }
    }

    const userData = {
      lineUserId: lineUserId,
      studentId: studentId,
      name: studentName,
      picture: ''
    };
    saveUserSession(userData);
    showMainApplication(userData);
    showToast(`เชื่อมโยงบัญชี LINE กับคุณ ${userData.name} สำเร็จ!`, 'success');
  } catch (err) {
    console.error('LINE Registration failed:', err);
    showToast('เกิดข้อผิดพลาดในการเชื่อมต่อ LINE', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i class="fa-solid fa-link"></i> ยืนยันเชื่อมต่อรหัสและเข้าหน้าหลัก`;
  }
}


function saveUserSession(userData) {
  currentUser = userData;
  localStorage.setItem('kmitl_pay_user', JSON.stringify(userData));
}

function logoutUser() {
  currentUser = null;
  localStorage.removeItem('kmitl_pay_user');
  document.getElementById('loginSection').style.display = 'block';
  document.getElementById('registerSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'none';
  document.getElementById('navControls').style.display = 'none';
  const navAdminLink = document.getElementById('navAdminLink');
  if (navAdminLink) navAdminLink.style.display = 'none';
  showToast('ออกจากระบบเรียบร้อยแล้ว', 'info');
}

function showMainApplication(user) {
  if (!user) return;
  const name = user.name || ('นักศึกษา รหัส ' + (user.studentId || ''));
  const displaySubtext = user.studentId || user.email || 'KMITL Student';

  const userNameEl = document.getElementById('userName');
  if (userNameEl) userNameEl.textContent = name;

  const userEmailEl = document.getElementById('userEmail');
  if (userEmailEl) userEmailEl.textContent = displaySubtext;

  const userAvatarEl = document.getElementById('userAvatar');
  if (userAvatarEl) userAvatarEl.textContent = name.trim().charAt(0).toUpperCase();

  const welcomeStudentNameEl = document.getElementById('welcomeStudentName');
  if (welcomeStudentNameEl) welcomeStudentNameEl.textContent = name;

  const loginSec = document.getElementById('loginSection');
  if (loginSec) loginSec.style.display = 'none';

  const regSec = document.getElementById('registerSection');
  if (regSec) regSec.style.display = 'none';

  const mainSec = document.getElementById('mainAppSection');
  if (mainSec) mainSec.style.display = 'block';

  const navCtrl = document.getElementById('navControls');
  if (navCtrl) navCtrl.style.display = 'flex';

  const navAdminLink = document.getElementById('navAdminLink');
  if (navAdminLink) {
    const adminIds = ['69010115', '69010165'];
    if (user.studentId && adminIds.includes(user.studentId.toString().trim())) {
      navAdminLink.style.display = 'inline-flex';
    } else {
      navAdminLink.style.display = 'none';
    }
  }

  // ==========================================
// STUDENT DASHBOARD RENDERER
// ==========================================
function renderStudentDashboard() {
  const grid = document.getElementById('feeItemsGrid');
  if (!grid) return;

  grid.innerHTML = '';

  // ==========================================
  // IDENTIFY CURRENT USER
  // ==========================================
  if (!currentUser) {
    grid.innerHTML = `
      <div style="
        grid-column:1/-1;
        text-align:center;
        padding:3rem;
        color:var(--text-muted);
      ">
        กรุณาเข้าสู่ระบบก่อน
      </div>
    `;

    const statUnpaid = document.getElementById('statUnpaid');
    const statPaid = document.getElementById('statPaid');
    const statPending = document.getElementById('statPending');

    if (statUnpaid) statUnpaid.textContent = '฿0';
    if (statPaid) statPaid.textContent = '฿0';
    if (statPending) statPending.textContent = '0 รายการ';

    return;
  }

  // ==========================================
  // USE STUDENT ID AS PRIMARY IDENTITY
  // ==========================================
  const currentStudentId =
    String(currentUser.studentId || '').trim();

  const currentLineUserId =
    String(currentUser.lineUserId || '').trim();

  const currentEmail =
    String(currentUser.email || '').trim().toLowerCase();

  const currentName =
    String(currentUser.name || '').trim();

  // ==========================================
  // FILTER ONLY CURRENT USER'S PAYMENTS
  // ==========================================
  const userSubsAll = submissions.filter(sub => {

    const subStudentId =
      String(sub.studentId || '').trim();

    const subLineUserId =
      String(sub.lineUserId || '').trim();

    const subEmail =
      String(
        sub.studentEmail ||
        sub.email ||
        ''
      ).trim().toLowerCase();

    const subName =
      String(sub.studentName || '').trim();

    // 1. Student ID = strongest match
    if (
      currentStudentId &&
      subStudentId &&
      subStudentId === currentStudentId
    ) {
      return true;
    }

    // 2. LINE User ID
    if (
      currentLineUserId &&
      subLineUserId &&
      subLineUserId === currentLineUserId
    ) {
      return true;
    }

    // 3. Email
    if (
      currentEmail &&
      currentEmail !== 'direct_login' &&
      subEmail &&
      subEmail === currentEmail
    ) {
      return true;
    }

    // 4. Name fallback
    if (
      currentName &&
      subName &&
      subName === currentName
    ) {
      return true;
    }

    return false;
  });

  console.log(
    '[Student Dashboard] Current user:',
    currentUser
  );

  console.log(
    '[Student Dashboard] User submissions:',
    userSubsAll
  );

  // ==========================================
  // STATISTICS
  // ==========================================
  let unpaidTotal = 0;
  let paidTotal = 0;
  let pendingCount = 0;

  // ==========================================
  // NO FEE ITEMS
  // ==========================================
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

    const statUnpaid = document.getElementById('statUnpaid');
    const statPaid = document.getElementById('statPaid');
    const statPending = document.getElementById('statPending');

    if (statUnpaid) {
      statUnpaid.textContent = '฿0';
    }

    if (statPaid) {
      statPaid.textContent = '฿0';
    }

    if (statPending) {
      statPending.textContent = '0 รายการ';
    }

    renderStudentHistoryTable();
    return;
  }

  // ==========================================
  // RENDER EACH FEE
  // ==========================================
  feeItems.forEach(item => {

    // ------------------------------------------
    // FIND PAYMENTS FOR THIS FEE
    // ------------------------------------------
    const relatedSubs = userSubsAll.filter(sub => {

      const sameFeeId =
        sub.feeId &&
        item.id &&
        String(sub.feeId).trim() ===
        String(item.id).trim();

      const sameFeeName =
        sub.feeName &&
        item.name &&
        String(sub.feeName).trim() ===
        String(item.name).trim();

      return sameFeeId || sameFeeName;
    });

    // ------------------------------------------
    // STATUS
    // ------------------------------------------
    const approvedSubs =
      relatedSubs.filter(
        sub =>
          normalizeStatus(sub.status) ===
          'Approved'
      );

    const pendingSubs =
      relatedSubs.filter(
        sub =>
          normalizeStatus(sub.status) ===
          'Pending'
      );

    const rejectedSubs =
      relatedSubs.filter(
        sub =>
          normalizeStatus(sub.status) ===
          'Rejected'
      );

    // ------------------------------------------
    // AMOUNTS
    // ------------------------------------------
    const paidAmount =
      approvedSubs.reduce(
        (sum, sub) =>
          sum +
          (parseFloat(sub.amount) || 0),
        0
      );

    paidTotal += paidAmount;

    const remaining =
      Math.max(
        0,
        (parseFloat(item.amount) || 0) -
        paidAmount
      );

    unpaidTotal += remaining;

    pendingCount +=
      pendingSubs.length;

    // ==========================================
    // STATUS BADGE
    // ==========================================
    let statusBadge = '';

    if (
      paidAmount >=
      (parseFloat(item.amount) || 0)
    ) {

      statusBadge = `
        <span class="fee-badge badge-paid">
          <i class="fa-solid fa-check"></i>
          ชำระแล้ว
        </span>
      `;

    } else if (
      pendingSubs.length > 0
    ) {

      statusBadge = `
        <span class="fee-badge badge-pending">
          <i class="fa-solid fa-clock"></i>
          รอตรวจสอบ
        </span>
      `;

    } else if (
      paidAmount > 0
    ) {

      statusBadge = `
        <span class="fee-badge badge-unpaid">
          <i class="fa-solid fa-circle-exclamation"></i>
          ชำระบางส่วน
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

    // ==========================================
    // PAYMENT BUTTON
    // ==========================================
    let paymentButton = '';

    // ------------------------------------------
    // FULLY PAID
    // ------------------------------------------
    if (
      paidAmount >=
      (parseFloat(item.amount) || 0)
    ) {

      paymentButton = `
        <button
          class="btn btn-secondary"
          style="
            width:100%;
            opacity:0.75;
            cursor:not-allowed;
          "
          disabled
        >
          <i class="fa-solid fa-circle-check"></i>
          ชำระแล้ว
        </button>
      `;

    // ------------------------------------------
    // WAITING FOR ADMIN
    // ------------------------------------------
    } else if (
      pendingSubs.length > 0
    ) {

      paymentButton = `
        <button
          class="btn btn-secondary"
          style="
            width:100%;
            opacity:0.75;
            cursor:not-allowed;
          "
          disabled
        >
          <i class="fa-solid fa-clock"></i>
          รอตรวจสอบ
        </button>
      `;

    // ------------------------------------------
    // PARTIALLY PAID
    // ------------------------------------------
    } else {

      paymentButton = `
        <button
          class="btn btn-primary"
          style="width:100%"
          onclick="openPaymentModal('${escapeHtml(String(item.id))}')"
        >
          <i class="fa-solid fa-qrcode"></i>
          ชำระเงิน / แนบสลิป
        </button>
      `;
    }

    // ==========================================
    // CREATE CARD
    // ==========================================
    const card =
      document.createElement('div');

    card.className =
      'glass-panel fee-card';

    card.innerHTML = `
      ${statusBadge}

      <div>
        <div class="fee-category">
          ${escapeHtml(item.category || '')}
        </div>

        <h4 class="fee-name">
          ${escapeHtml(item.name || '')}
        </h4>

        <p class="fee-description">
          ${escapeHtml(item.description || '')}
        </p>
      </div>

      <div>
        <div class="fee-meta">

          <div class="fee-amount">
            <span>จำนวนเงิน</span>

            <strong>
              ฿${(
                parseFloat(item.amount) || 0
              ).toLocaleString()}
            </strong>
          </div>

          <div class="fee-due">
            <i class="fa-regular fa-calendar"></i>
            ครบกำหนด:
            ${escapeHtml(item.dueDate || '-')}
          </div>

        </div>

        ${paymentButton}

      </div>
    `;

    grid.appendChild(card);
  });

  // ==========================================
  // UPDATE STATISTICS
  // ==========================================
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

  // ==========================================
  // PAYMENT HISTORY
  // ==========================================
  renderStudentHistoryTable();
}
