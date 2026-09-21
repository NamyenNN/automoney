/**
 * KMITL Class Payment System - Core Application Logic
 * Feature List:
 * Google Sign-In with @kmitl.ac.th validation
 * Persistent session (remember login)
 * Persistent Fee Items in LocalStorage
 * Persistent Settings (Google Script Web App URL & PromptPay info)
 * Dynamic PromptPay QR Code generator
 * Slip upload & Client-side QR Reader (jsQR)
 * Google Sheet & Google Drive integration via Apps Script
 * Admin Treasurer View & Student Dashboard
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
CONFIG.LINE_CHANNEL_SECRET = ''; // ห้ามเก็บ Channel Secret ใน frontend
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
let currentPaymentQty = 1;

// Fee Items & Submissions
let feeItems = JSON.parse(localStorage.getItem('kmitl_pay_fee_items')) || DEFAULT_FEE_ITEMS;
let submissions = JSON.parse(localStorage.getItem('kmitl_pay_submissions')) || [];

// ==========================================
// TEXT & STATUS HELPERS
// ==========================================
function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeStatus(st) {
  if (!st) return 'Pending';
  const str = String(st).trim().toLowerCase();
  
  if (str.includes('reject') || str.includes('ปฏิเสธ') || str.includes('ไม่อนุมัติ')) {
    return 'Rejected';
  }
  if (str.includes('approved') || str === 'approve' || str.includes('อนุมัติ') || str.includes('ชำระแล้ว') || str.includes('paid')) {
    return 'Approved';
  }
  return 'Pending';
}

// ฟังก์ชันเทียบนักศึกษาให้แม่นยำ (แก้ปัญหาจ่ายแล้วขึ้นยังไม่ได้จ่าย)
function isSameStudent(sub, user) {
  if (!sub || !user) return false;
  
  const userId = normalizeText(user.studentId);
  const subId = normalizeText(sub.studentId || sub.studentEmail);
  const userName = normalizeText(user.name);
  const subName = normalizeText(sub.studentName);

  // 1. เทียบด้วยรหัสนักศึกษา (แม่นยำที่สุด)
  if (userId && subId && userId === subId) return true;
  
  // 2. เทียบสำรองด้วยชื่อ-นามสกุล
  if (userName && subName && (userName === subName || subName.includes(userName) || userName.includes(subName))) {
    return true;
  }
  
  return false;
}

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 KMITL Pay starting...');
  
  try {
    setupDragAndDrop();
    checkGasConfigAlert();
  } catch (err) {
    console.warn('Basic setup warning:', err);
  }

  // Admin Page check
  if (window.location.pathname.toLowerCase().includes('admin.html')) {
    currentView = 'admin';
    renderAdminDashboard();
    fetchSubmissionsFromGas().catch(err => console.warn('Admin payment sync error:', err));
    fetchFeeItemsFromGas().catch(err => console.warn('Admin fee sync error:', err));
    return;
  }

  // LINE OAuth Callback check
  const urlParams = new URLSearchParams(window.location.search);
  const lineCode = urlParams.get('code');
  if (lineCode) {
    console.log('🔑 LINE OAuth callback');
    checkLineAuthCode(lineCode);
    return;
  }

  // Restore session
  const restored = checkSavedSession();
  if (restored) {
    console.log('✅ Existing session found - SKIP LINE LOGIN');
    fetchSubmissionsFromGas().catch(err => console.warn('Payment sync error:', err));
    fetchFeeItemsFromGas().catch(err => console.warn('Fee sync error:', err));
    return;
  }

  // Try LIFF Auto-login
  console.log('🔎 No saved session, trying LIFF...');
  const liffPromise = checkLiffAutoLogin();
  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(false), 5000));
  const liffLoggedIn = await Promise.race([liffPromise, timeoutPromise]);
  
  if (!liffLoggedIn) {
    console.log('ℹ️ LIFF login unavailable');
    checkSavedSession();
  }

  // Background sync
  fetchSubmissionsFromGas().catch(err => console.warn('Payment sync error:', err));
  fetchFeeItemsFromGas().catch(err => console.warn('Fee sync error:', err));
});

// ==========================================
// SESSION MANAGEMENT (แก้ปัญหาต้องกรอกรหัสใหม่)
// ==========================================
function checkSavedSession() {
  const savedUser = localStorage.getItem('kmitl_pay_user');
  console.log('🔐 Checking saved session:', savedUser ? 'FOUND' : 'NOT FOUND');

  if (savedUser) {
    try {
      const user = JSON.parse(savedUser);
      if (user && user.studentId && String(user.studentId).trim() !== '') {
        currentUser = user;
        showMainApplication(user);
        return true;
      }
    } catch (err) {
      console.warn('⚠️ Cannot parse saved session:', err);
    }
  }

  currentUser = null;
  const loginSection = document.getElementById('loginSection');
  const registerSection = document.getElementById('registerSection');
  const mainAppSection = document.getElementById('mainAppSection');
  const navControls = document.getElementById('navControls');

  if (loginSection) loginSection.style.display = 'block';
  if (registerSection) registerSection.style.display = 'none';
  if (mainAppSection) mainAppSection.style.display = 'none';
  if (navControls) navControls.style.display = 'none';

  return false;
}

function saveUserSession(userData) {
  if (!userData) return;
  if (userData.studentId) userData.studentId = String(userData.studentId).trim();
  if (userData.lineUserId) userData.lineUserId = String(userData.lineUserId).trim();
  if (userData.name) userData.name = String(userData.name).trim();
  
  currentUser = userData;
  localStorage.setItem('kmitl_pay_user', JSON.stringify(userData));
  console.log('💾 Session saved successfully:', userData);
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

// ==========================================
// GOOGLE SHEET & GAS SYNC (ผูกข้อมูลรหัสนักศึกษาให้ถูกต้อง)
// ==========================================
async function fetchSubmissionsFromGas() {
  if (!CONFIG.GOOGLE_SCRIPT_URL) return;
  try {
    const url = CONFIG.GOOGLE_SCRIPT_URL + (CONFIG.GOOGLE_SCRIPT_URL.includes('?') ? '&' : '?') + 'action=getPayments&t=' + Date.now();
    const response = await fetch(url);
    const result = await response.json();
    
    if (result && result.status === 'success' && Array.isArray(result.data)) {
      submissions = result.data.map((row, idx) => {
        const idVal = row['ข้อมูลประจำตัว/รหัส'] ? row['ข้อมูลประจำตัว/รหัส'].toString().trim() : '';
        return {
          id: 'gas-' + idx,
          timestamp: row['วันเวลาที่ส่ง'] ? row['วันเวลาที่ส่ง'].toString() : '',
          studentName: row['ชื่อ-นามสกุล'] ? row['ชื่อ-นามสกุล'].toString().trim() : '',
          studentId: idVal,     // แมปค่ารหัสนักศึกษาให้ตรงกัน
          studentEmail: idVal,  // รองรับการค้นหาผ่านช่องทางนี้ด้วย
          feeName: row['รายการชำระเงิน'] ? row['รายการชำระเงิน'].toString() : '',
          amount: parseFloat(row['จำนวนเงิน (บาท)']) || 0,
          status: row['สถานะ'] ? normalizeStatus(row['สถานะ']) : 'Pending',
          slipUrl: row['ลิงก์สลิปใน Google Drive'] ? row['ลิงก์สลิปใน Google Drive'].toString() : '',
          qrRef: row['ข้อมูล QR Ref บนสลิป'] ? row['ข้อมูล QR Ref บนสลิป'].toString() : '',
          remark: row['หมายเหตุ'] ? row['หมายเหตุ'].toString() : ''
        };
      });
      
      localStorage.setItem('kmitl_pay_submissions', JSON.stringify(submissions));
      if (currentView === 'admin') renderAdminDashboard();
      if (currentView === 'student') renderStudentDashboard();
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
      feeItems = result.data.map(item => {
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
      
      saveFeeItemsToStorage();
      renderStudentDashboard();
      renderAdminDashboard();
    }
  } catch (err) {
    console.warn('Fetch fee items error:', err);
  }
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
        <div><i class="fa-solid fa-triangle-exclamation"></i> <strong>ยังไม่ได้ระบุ Google Apps Script Web App URL:</strong> ระบบทำงานในโหมดออฟไลน์</div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">ตั้งค่า</button>
      </div>`;
  } else {
    alertBox.style.display = 'block';
    alertBox.innerHTML = `
      <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: var(--color-success); padding: 12px 16px; border-radius: 12px; font-size: 0.875rem; display: flex; align-items: center; justify-content: space-between;">
        <div><i class="fa-solid fa-circle-check"></i> <strong>เชื่อมต่อ Google Apps Script เรียบร้อย</strong></div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">แก้ไข</button>
      </div>`;
  }
}

// ==========================================
// LIFF & LINE LOGIN
// ==========================================
async function checkLiffAutoLogin() {
  if (!CONFIG.LIFF_ID || typeof liff === 'undefined') return false;
  try {
    await liff.init({ liffId: CONFIG.LIFF_ID });
    if (!liff.isLoggedIn()) return false;
    
    const profile = await liff.getProfile();
    if (!profile || !profile.userId) return false;
    
    return await processLiffProfile(profile);
  } catch (err) {
    console.warn('⚠️ LIFF Auto-login error:', err);
    return false;
  }
}

async function processLiffProfile(profile) {
  if (!profile || !profile.userId) return false;
  const lineUserId = String(profile.userId).trim();
  const lineName = profile.displayName || 'LINE User';
  const picture = profile.pictureUrl || '';

  const savedUserRaw = localStorage.getItem('kmitl_pay_user');
  if (savedUserRaw) {
    try {
      const savedUser = JSON.parse(savedUserRaw);
      if (savedUser && savedUser.studentId && savedUser.lineUserId && String(savedUser.lineUserId).trim() === lineUserId) {
        currentUser = savedUser;
        showMainApplication(savedUser);
        return true;
      }
    } catch (e) {
      console.warn('Saved session parse error:', e);
    }
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) return false;

  try {
    const url = CONFIG.GOOGLE_SCRIPT_URL + '?action=checkLineUser&lineUserId=' + encodeURIComponent(lineUserId) + '&t=' + Date.now();
    const response = await fetch(url);
    const result = await response.json();

    if (result && result.status === 'success' && result.registered) {
      const userData = {
        lineUserId: lineUserId,
        name: result.name || lineName,
        studentId: String(result.studentId || '').trim(),
        picture: picture
      };

      if (!userData.studentId) {
        showRegistrationScreen(lineUserId, lineName);
        return false;
      }

      saveUserSession(userData);
      showMainApplication(userData);
      return true;
    }

    if (result && result.status === 'success' && !result.registered) {
      showRegistrationScreen(lineUserId, lineName);
      return false;
    }
  } catch (err) {
    console.error('❌ LIFF Profile Check Error:', err);
  }
  return false;
}

// ==========================================
// UI NAVIGATION & RENDERING
// ==========================================
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

  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('registerSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'block';
  document.getElementById('navControls').style.display = 'flex';

  renderStudentDashboard();
}

function switchView(view) {
  currentView = view;
  const studentBtn = document.getElementById('tabStudentBtn');
  const adminBtn = document.getElementById('tabAdminBtn');
  const studentView = document.getElementById('studentView');
  const adminView = document.getElementById('adminView');

  if (view === 'student') {
    studentBtn.classList.add('active');
    adminBtn.classList.remove('active');
    studentView.style.display = 'block';
    adminView.style.display = 'none';
    renderStudentDashboard();
  } else {
    adminBtn.classList.add('active');
    studentBtn.classList.remove('active');
    studentView.style.display = 'none';
    adminView.style.display = 'block';
    renderAdminDashboard();
  }
}

function renderStudentDashboard() {
  const grid = document.getElementById('feeItemsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  console.log('Rendering Student Dashboard with updated student filter...');
}

function renderAdminDashboard() {
  if (currentView !== 'admin') return;
  console.log('Rendering Admin Dashboard...');
}
