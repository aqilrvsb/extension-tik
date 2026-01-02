/**
 * Popup Script for TikTok Order Exporter
 * v2.9.2 - License info display with package, validity, days remaining
 */

const DEBUG = false; // Set to true for verbose logging
function debugLog(...args) {
  if (DEBUG) console.log('[Popup]', ...args);
}

// Supabase config for license validation
const SUPABASE_URL = 'https://rfvocvjwlxpiaxbciqnn.supabase.co';
// Using service_role key for license validation (table has RLS enabled)
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmdm9jdmp3bHhwaWF4YmNpcW5uIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjI4Njk4OCwiZXhwIjoyMDgxODYyOTg4fQ.Y2EjxYd9F6KnfSSnCPuDJZJTEdTkpgRU8_mLEP9sqgM';

// DOM Elements
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const currentOrder = document.getElementById('currentOrder');
const currentOrderId = document.getElementById('currentOrderId');
const statsGrid = document.getElementById('statsGrid');
const successCount = document.getElementById('successCount');
const failedCount = document.getElementById('failedCount');
const skippedCount = document.getElementById('skippedCount');
const remainingCount = document.getElementById('remainingCount');
const startBtn = document.getElementById('startBtn');
const runningBtns = document.getElementById('runningBtns');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadCsvBtn = document.getElementById('downloadCsvBtn');
const downloadXlsxBtn = document.getElementById('downloadXlsxBtn');
const pausedBtns = document.getElementById('pausedBtns');
const resumePausedBtn = document.getElementById('resumePausedBtn');
const stopPausedBtn = document.getElementById('stopPausedBtn');
const logSection = document.getElementById('logSection');
const historySection = document.getElementById('historySection');
const historyInfo = document.getElementById('historyInfo');
const resumeBtn = document.getElementById('resumeBtn');
const historyCsvBtn = document.getElementById('historyCsvBtn');
const historyXlsxBtn = document.getElementById('historyXlsxBtn');
const settingsSection = document.getElementById('settingsSection');
const storageCount = document.getElementById('storageCount');
const clearStorageBtn = document.getElementById('clearStorageBtn');
const openDashboardBtn = document.getElementById('openDashboardBtn');

// Date filter element (single date)
const filterDateInput = document.getElementById('filterDate');

// Page range elements
const startPageInput = document.getElementById('startPage');
const endPageInput = document.getElementById('endPage');

// License info elements
const licenseInfoSection = document.getElementById('licenseInfoSection');
const licensePackage = document.getElementById('licensePackage');
const licenseValidity = document.getElementById('licenseValidity');
const licenseDaysLeft = document.getElementById('licenseDaysLeft');

// State
let isRunning = false;
let exportStartTime = null; // Track when export started for time estimation

// Time estimate elements
const timeEstimate = document.getElementById('timeEstimate');
const timeRemaining = document.getElementById('timeRemaining');

// Page and Order progress elements
const pageOrderProgress = document.getElementById('pageOrderProgress');
const pageProgress = document.getElementById('pageProgress');
const orderProgress = document.getElementById('orderProgress');

// ========================================
// LICENSE VALIDATION FUNCTIONS
// ========================================

/**
 * Get the current shop code from the active TikTok Seller Center tab
 */
async function getCurrentShopCode() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes('seller')) {
        resolve(null);
        return;
      }

      try {
        // Execute script to get shop code from page
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Method 1: Find the EXACT element containing "Shop Code:" text
            // Looking for elements like: <div class="css-14kkcet">Shop Code: MYLCV9LW9B</div>
            // Must be a leaf element (no children with text) to avoid picking up parent containers
            const allElements = document.querySelectorAll('div, span, p');
            for (const el of allElements) {
              // Get ONLY direct text content of this element (not children)
              const directText = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                ? el.childNodes[0].textContent.trim()
                : el.textContent.trim();

              // Must be short text containing "Shop Code:" - avoid large container divs
              if (directText.length < 50 && (directText.includes('Shop Code:') || directText.includes('Shop Code :'))) {
                // Extract EXACTLY 10 characters after "Shop Code:"
                // TikTok shop codes are exactly 10 chars like MYLCV9LW9B
                const match = directText.match(/Shop\s*Code\s*:\s*([A-Z0-9]{10})\b/i);
                if (match && match[1]) {
                  console.log('[ShopCodeDetect] Found exact match:', match[1]);
                  return match[1].toUpperCase();
                }
              }
            }

            // Method 2: Search in full body text with strict 10-char pattern
            const bodyText = document.body.innerText || '';
            const textMatch = bodyText.match(/Shop\s*Code\s*:\s*([A-Z0-9]{10})\b/i);
            if (textMatch && textMatch[1]) {
              console.log('[ShopCodeDetect] Found in body text:', textMatch[1]);
              return textMatch[1].toUpperCase();
            }

            // Method 3: Look in URL params
            const urlMatch = window.location.href.match(/[?&]shop_code=([A-Z0-9]+)/i);
            if (urlMatch) {
              console.log('[ShopCodeDetect] Found in URL:', urlMatch[1]);
              return urlMatch[1].toUpperCase();
            }

            // Method 4: Search in script tags for JSON data
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
              const content = script.textContent || '';
              const jsonMatch = content.match(/["']shop_?[Cc]ode["']\s*:\s*["']([A-Z0-9]{10})["']/i);
              if (jsonMatch) {
                console.log('[ShopCodeDetect] Found in script:', jsonMatch[1]);
                return jsonMatch[1].toUpperCase();
              }
            }

            console.log('[ShopCodeDetect] No shop code found');
            return null;
          }
        });

        resolve(results[0]?.result || null);
      } catch (error) {
        console.error('Error getting shop code:', error);
        resolve(null);
      }
    });
  });
}

/**
 * Generate a random license key (internal use only)
 */
function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

/**
 * Create a new TRIAL license for a shop code
 */
async function createTrialLicense(shopCode) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // TRIAL = 2 days validity
    const validUntil = new Date(today);
    validUntil.setDate(validUntil.getDate() + 2);
    validUntil.setHours(23, 59, 59, 999);

    const licenseKey = generateLicenseKey();

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/licenses`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          license_key: licenseKey,
          shop_code: shopCode.toUpperCase().trim(),
          shop_name: null,
          package_type: 'TRIAL',
          notes: 'Auto-created TRIAL from extension',
          valid_from: today.toISOString(),
          valid_until: validUntil.toISOString(),
          is_active: true
        })
      }
    );

    if (!response.ok) {
      console.error('Failed to create trial license:', await response.text());
      return null;
    }

    const created = await response.json();
    return created[0] || created;
  } catch (error) {
    console.error('Error creating trial license:', error);
    return null;
  }
}

/**
 * Validate shop code against Supabase licenses table
 * - If shop doesn't exist: auto-create TRIAL license
 * - If expired: show renewal message
 */
async function validateShopCode(shopCode) {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/licenses?shop_code=eq.${encodeURIComponent(shopCode)}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    if (!response.ok) {
      return { valid: false, error: 'Failed to validate license' };
    }

    const licenses = await response.json();

    // Shop not found - auto-create TRIAL license
    if (licenses.length === 0) {
      debugLog('[License] Shop not found, creating TRIAL license...');

      const newLicense = await createTrialLicense(shopCode);

      if (newLicense) {
        // Calculate days remaining (should be 2 for new trial)
        // Use date-only comparison to get accurate day count
        const validUntil = new Date(newLicense.valid_until);
        const now = new Date();
        // Reset time to midnight for accurate day calculation
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const untilMidnight = new Date(validUntil.getFullYear(), validUntil.getMonth(), validUntil.getDate());
        const daysRemaining = Math.round((untilMidnight - todayMidnight) / (1000 * 60 * 60 * 24));

        return {
          valid: true,
          license: newLicense,
          daysRemaining: daysRemaining,
          shopCode: newLicense.shop_code,
          packageType: 'TRIAL',
          validUntil: newLicense.valid_until,
          isNewTrial: true // Flag to show welcome message
        };
      } else {
        return { valid: false, error: 'Failed to create trial license. Please contact admin.' };
      }
    }

    const license = licenses[0];

    // Check if license is active
    if (!license.is_active) {
      return { valid: false, error: 'License has been disabled. Please contact admin.' };
    }

    // Check if license is expired
    const now = new Date();
    const validFrom = new Date(license.valid_from);
    const validUntil = new Date(license.valid_until);

    if (now < validFrom) {
      return { valid: false, error: 'License not yet valid' };
    }

    // EXPIRED - show renewal message
    if (now > validUntil) {
      const expiredDays = Math.ceil((now - validUntil) / (1000 * 60 * 60 * 24));
      return {
        valid: false,
        error: `License expired ${expiredDays} day(s) ago. Please renew to continue using.`,
        isExpired: true,
        packageType: license.package_type || 'PRO'
      };
    }

    // Calculate days remaining using date-only comparison
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const untilMidnight = new Date(validUntil.getFullYear(), validUntil.getMonth(), validUntil.getDate());
    const daysRemaining = Math.round((untilMidnight - todayMidnight) / (1000 * 60 * 60 * 24));

    return {
      valid: true,
      license: license,
      daysRemaining: daysRemaining,
      shopCode: license.shop_code,
      packageType: license.package_type || 'PRO',
      validUntil: license.valid_until
    };
  } catch (error) {
    console.error('License validation error:', error);
    return { valid: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Check license before starting export
 * Now validates by shop code directly - no license key input needed
 * - Auto-creates TRIAL for new shops
 * - Shows renewal message for expired
 * Returns true if license is valid, false otherwise
 */
async function checkLicenseBeforeStart() {
  // Get current shop code FIRST - this is REQUIRED
  const currentShopCode = await getCurrentShopCode();

  if (!currentShopCode) {
    // Must be on TikTok Seller Center page to detect shop code
    addLog('Please open TikTok Seller Center first', 'error');
    addLog('Make sure shop code is visible on the page', 'info');
    return false;
  }

  debugLog('[License] Current shop code:', currentShopCode);
  addLog(`Validating shop: ${currentShopCode}...`, 'info');

  // ALWAYS validate fresh from Supabase on every export start
  // No caching - verify every time to ensure license is still valid
  const result = await validateShopCode(currentShopCode);

  if (result.valid) {
    // Check if this is a newly created trial
    if (result.isNewTrial) {
      addLog('Welcome! TRIAL license created (2 days)', 'success');
      addLog('Contact admin to upgrade to PRO package', 'info');
    } else {
      addLog(`License valid! ${result.daysRemaining} days remaining`, 'success');
    }

    // Warning if expiring soon
    if (result.daysRemaining <= 3) {
      addLog(`License expiring soon! Renew to avoid interruption.`, 'warn');
    }

    // Update license info display
    updateLicenseInfoDisplay(result);
    return true;
  } else {
    // License validation failed
    if (result.isExpired) {
      addLog(result.error, 'error');
      addLog('Contact admin to renew your license.', 'info');
    } else {
      addLog(result.error, 'error');
    }
    hideLicenseInfoDisplay();
    return false;
  }
}

/**
 * Update license info display section
 */
function updateLicenseInfoDisplay(licenseData) {
  if (!licenseInfoSection) return;

  // Show the section
  licenseInfoSection.style.display = 'block';

  // Set package type
  const packageType = licenseData.packageType || 'PRO';
  licensePackage.textContent = packageType;
  licensePackage.className = 'license-info-value ' + (packageType === 'TRIAL' ? 'trial' : 'pro');

  // Set validity date
  const validUntil = new Date(licenseData.validUntil);
  const formattedDate = validUntil.toLocaleDateString('en-MY', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
  licenseValidity.textContent = formattedDate;

  // Set days remaining with warning if low
  const daysLeft = licenseData.daysRemaining;
  licenseDaysLeft.textContent = daysLeft + ' days';
  if (daysLeft <= 3) {
    licenseDaysLeft.className = 'license-info-value warning';
    licenseInfoSection.className = 'license-info-section expiring';
  } else if (packageType === 'TRIAL') {
    licenseDaysLeft.className = 'license-info-value trial';
    licenseInfoSection.className = 'license-info-section trial';
  } else {
    licenseDaysLeft.className = 'license-info-value pro';
    licenseInfoSection.className = 'license-info-section';
  }
}

/**
 * Hide license info display
 */
function hideLicenseInfoDisplay() {
  if (licenseInfoSection) {
    licenseInfoSection.style.display = 'none';
  }
}

/**
 * Check and display license info on popup open
 * Also shows messages for new trials and expired licenses
 */
async function checkAndDisplayLicenseInfo() {
  const currentShopCode = await getCurrentShopCode();

  if (!currentShopCode) {
    hideLicenseInfoDisplay();
    return;
  }

  const result = await validateShopCode(currentShopCode);

  if (result.valid) {
    updateLicenseInfoDisplay(result);

    // Show welcome message for new trial
    if (result.isNewTrial) {
      addLog(`Welcome ${currentShopCode}! TRIAL activated (2 days)`, 'success');
    }

    // Warning for expiring soon
    if (result.daysRemaining <= 3 && !result.isNewTrial) {
      addLog(`License expiring in ${result.daysRemaining} day(s)!`, 'warn');
    }
  } else {
    hideLicenseInfoDisplay();

    // Show expired message
    if (result.isExpired) {
      addLog(`Shop ${currentShopCode}: License expired`, 'error');
      addLog('Please renew to continue using', 'info');
    }
  }
}

// ========================================
// MAIN FUNCTIONS
// ========================================

// Initialize on popup open
async function init() {
  // Load saved settings
  const settings = await chrome.storage.local.get(['filterDate', 'startPage', 'endPage']);

  // Load page range settings
  if (settings.startPage) startPageInput.value = settings.startPage;
  if (settings.endPage) endPageInput.value = settings.endPage;

  // Load date filter setting
  if (settings.filterDate) {
    filterDateInput.value = settings.filterDate;
  } else {
    // Default to today
    filterDateInput.value = new Date().toISOString().split('T')[0];
  }

  // Load storage count
  await updateStorageCount();

  // Check and display license info on popup open
  await checkAndDisplayLicenseInfo();

  // Check for previous session state
  await checkPreviousSession();

  // Get current status from background
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response) {
      updateUI(response);
    }
  });
}

// Update storage count display
async function updateStorageCount() {
  const storage = await chrome.storage.local.get(['exportedOrders']);
  const count = storage.exportedOrders ? storage.exportedOrders.length : 0;
  storageCount.textContent = count;
}

// Check for previous interrupted session and auto-resume
// Note: Force stop (button click) clears session, so this only triggers for natural interruptions
// Note: Paused by human does NOT auto-resume - user must manually resume
async function checkPreviousSession() {
  const sessionData = await chrome.storage.local.get(['sessionState']);
  const session = sessionData.sessionState;

  if (session && session.orderIds && session.orderIds.length > 0 && session.currentOrderIndex < session.orderIds.length) {
    // Check if paused by human - do NOT auto-resume
    if (session.pausedByHuman) {
      const remaining = session.orderIds.length - session.currentOrderIndex;
      debugLog(' Found paused session (by user), showing manual resume...');

      // Show paused state with resume button
      statusIcon.textContent = '⏸️';
      statusText.textContent = `Paused: ${remaining} orders remaining`;
      setRunningState(false, true); // Show paused buttons

      // Update stats
      statsGrid.style.display = 'grid';
      successCount.textContent = session.success || 0;
      failedCount.textContent = session.failed || 0;
      skippedCount.textContent = session.skipped || 0;
      remainingCount.textContent = remaining;
      return;
    }

    // There's an interrupted session (natural interruption, not force stop or pause)
    // AUTO RESUME since force stop clears session state
    const remaining = session.orderIds.length - session.currentOrderIndex;
    const success = session.success || 0;
    const failed = session.failed || 0;

    debugLog(' Found interrupted session, auto-resuming...');
    debugLog(' Progress:', session.currentOrderIndex, '/', session.orderIds.length);

    // Show brief notification then auto-resume
    statusIcon.textContent = '🔄';
    statusText.textContent = `Auto-resuming: ${remaining} orders remaining...`;

    // Auto-resume after a short delay
    setTimeout(() => {
      autoResume();
    }, 500);
  } else {
    historySection.classList.remove('show');
  }
}

// Auto-resume function
function autoResume() {
  // Delay values (2-7 seconds)
  const delayMin = 2;
  const delayMax = 7;

  chrome.runtime.sendMessage({
    type: 'RESUME_EXPORT',
    delayMinMs: delayMin * 1000,
    delayMaxMs: delayMax * 1000
  }, (response) => {
    if (response && response.success) {
      setRunningState(true);
      addLog('Auto-resumed export...', 'info');
      historySection.classList.remove('show');
    } else if (response && response.error) {
      // If auto-resume fails, show manual resume option
      debugLog(' Auto-resume failed:', response.error);
      historySection.classList.add('show');
      startBtn.style.display = 'none';
      addLog('Auto-resume failed: ' + response.error, 'error');
    }
  });
}

// Date filter input
filterDateInput.addEventListener('change', () => {
  chrome.storage.local.set({ filterDate: filterDateInput.value });
});

// Page range inputs
startPageInput.addEventListener('change', () => {
  let start = parseInt(startPageInput.value) || 1;
  let end = parseInt(endPageInput.value) || 1;
  if (start > end) {
    endPageInput.value = start;
  }
  chrome.storage.local.set({ startPage: start, endPage: parseInt(endPageInput.value) });
});

endPageInput.addEventListener('change', () => {
  let start = parseInt(startPageInput.value) || 1;
  let end = parseInt(endPageInput.value) || 1;
  if (end < start) {
    startPageInput.value = end;
  }
  chrome.storage.local.set({ startPage: parseInt(startPageInput.value), endPage: end });
});

// Sound effects using Web Audio API
function playSound(type) {
  if (type === 'success') {
    // Pleasant success chime (C5 -> E5 -> G5)
    playChime([523, 659, 784], 150);
  } else {
    // Warning tone (lower pitched)
    playChime([392, 330], 200);
  }
}

// Play a chime with multiple notes
function playChime(frequencies, noteLength = 150) {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    frequencies.forEach((freq, index) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = freq;
      oscillator.type = 'sine';
      gainNode.gain.value = 0.2;

      const startTime = audioContext.currentTime + (index * noteLength / 1000);
      const endTime = startTime + (noteLength / 1000);

      oscillator.start(startTime);
      gainNode.gain.setValueAtTime(0.2, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, endTime);
      oscillator.stop(endTime + 0.1);
    });
  } catch (err) {
    debugLog(' Could not play sound:', err);
  }
}

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message) => {
  debugLog(' Message:', message);

  if (message.type === 'STATUS_UPDATE') {
    updateUI(message);
  } else if (message.type === 'LOG') {
    addLog(message.text, message.level);
  } else if (message.type === 'PLAY_SOUND') {
    playSound(message.sound);
  }
});

// Start button click
startBtn.addEventListener('click', async () => {
  // Validate date is set
  if (!filterDateInput.value) {
    addLog('Please select a date.', 'error');
    filterDateInput.style.borderColor = 'red';
    setTimeout(() => { filterDateInput.style.borderColor = ''; }, 2000);
    return;
  }

  // Validate page range
  const startPage = parseInt(startPageInput.value) || 1;
  const endPage = parseInt(endPageInput.value) || 1;
  if (startPage > endPage) {
    addLog('Start page cannot be greater than end page.', 'error');
    return;
  }

  // Check license first
  const hasValidLicense = await checkLicenseBeforeStart();

  if (!hasValidLicense) {
    // License check failed - no modal needed anymore, just show error
    return;
  }

  // License valid, start export
  startExport();
});

// Actual start export function
function startExport() {
  const startPage = parseInt(startPageInput.value) || 1;
  const endPage = parseInt(endPageInput.value) || 1;
  const filterDate = filterDateInput.value;

  // Delay values (2-7 seconds)
  const delayMin = 2;
  const delayMax = 7;

  // Save settings
  chrome.storage.local.set({
    filterDate,
    startPage,
    endPage
  });

  // Build message with page range and date
  const message = {
    type: 'START_EXPORT',
    startPage,
    endPage,
    delayMinMs: delayMin * 1000,
    delayMaxMs: delayMax * 1000,
    dateFilter: {
      date: filterDate // Single date format: YYYY-MM-DD
    }
  };

  addLog(`Date: ${filterDate}, Pages: ${startPage}-${endPage}`, 'info');

  // Send start command to background
  chrome.runtime.sendMessage(message, (response) => {
    if (response && response.success) {
      setRunningState(true);
      addLog('Export started...', 'info');
      historySection.classList.remove('show');
    } else if (response && response.error) {
      addLog('Error: ' + response.error, 'error');
    }
  });
}

// Resume button click
resumeBtn.addEventListener('click', async () => {
  // Delay values (2-7 seconds)
  const delayMin = 2;
  const delayMax = 7;

  chrome.runtime.sendMessage({
    type: 'RESUME_EXPORT',
    delayMinMs: delayMin * 1000,
    delayMaxMs: delayMax * 1000
  }, (response) => {
    if (response && response.success) {
      setRunningState(true);
      addLog('Resuming export...', 'info');
      historySection.classList.remove('show');
    } else if (response && response.error) {
      addLog('Error: ' + response.error, 'error');
    }
  });
});

// Pause button click
pauseBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'PAUSE_EXPORT' }, (response) => {
    if (response && response.paused) {
      addLog('Export paused by user', 'warn');
      setRunningState(false, true); // Show paused state
    }
  });
});

// Stop button click
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_EXPORT' }, (response) => {
    addLog('Export stopped by user', 'info');
    setRunningState(false);
  });
});

// Resume from paused state
resumePausedBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESUME_PAUSED' }, (response) => {
    if (response && response.success) {
      addLog('Resuming export...', 'info');
      setRunningState(true);
    } else if (response && response.error) {
      addLog('Resume error: ' + response.error, 'error');
    }
  });
});

// Stop from paused state
stopPausedBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_EXPORT' }, (response) => {
    addLog('Export stopped by user', 'info');
    setRunningState(false);
  });
});

// Download CSV button click (during processing or after)
downloadCsvBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV' }, (response) => {
    if (response && response.success) {
      addLog(`Exported ${response.count} orders to CSV!`, 'success');
    } else if (response && response.error) {
      addLog('Download error: ' + response.error, 'error');
    }
  });
});

// Download XLSX button click (during processing or after)
downloadXlsxBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_XLSX' }, (response) => {
    if (response && response.success) {
      addLog(`Exported ${response.count} orders to Excel!`, 'success');
    } else if (response && response.error) {
      addLog('Download error: ' + response.error, 'error');
    }
  });
});

// History CSV download button click
historyCsvBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV' }, (response) => {
    if (response && response.success) {
      addLog(`Exported ${response.count} orders to CSV!`, 'success');
    } else if (response && response.error) {
      addLog('Download error: ' + response.error, 'error');
    }
  });
});

// History XLSX download button click
historyXlsxBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_XLSX' }, (response) => {
    if (response && response.success) {
      addLog(`Exported ${response.count} orders to Excel!`, 'success');
    } else if (response && response.error) {
      addLog('Download error: ' + response.error, 'error');
    }
  });
});

// Clear storage button
clearStorageBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear all exported orders data? This cannot be undone.')) {
    await chrome.storage.local.remove(['exportedOrders', 'sessionState']);
    await updateStorageCount();
    historySection.classList.remove('show');
    startBtn.style.display = 'block';
    statsGrid.style.display = 'none';
    progressSection.classList.remove('show');
    addLog('All data cleared', 'info');
  }
});

// Open dashboard button
openDashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// Calculate and format time estimate
function calculateTimeEstimate(processed, total, remaining) {
  if (!exportStartTime || processed < 2 || remaining <= 0) {
    return null;
  }

  const elapsedMs = Date.now() - exportStartTime;
  const avgTimePerOrder = elapsedMs / processed;
  const estimatedRemainingMs = avgTimePerOrder * remaining;

  // Format time
  const totalSeconds = Math.round(estimatedRemainingMs / 1000);
  if (totalSeconds < 60) {
    return `~${totalSeconds} sec remaining`;
  } else if (totalSeconds < 3600) {
    const minutes = Math.round(totalSeconds / 60);
    return `~${minutes} min remaining`;
  } else {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.round((totalSeconds % 3600) / 60);
    return `~${hours}h ${minutes}m remaining`;
  }
}

// Update UI based on status
function updateUI(status) {
  isRunning = status.isRunning;

  // Always show progress and stats if we have data
  const hasData = status.total > 0 || status.success > 0 || status.failed > 0;

  // Check for paused state
  if (status.isPaused) {
    setRunningState(false, true); // Paused state
    statusIcon.textContent = '⏸️';
    statusText.textContent = status.message || 'Export paused';
    statusText.classList.remove('running');

    // Show progress while paused
    if (hasData) {
      progressSection.classList.add('show');
      const totalProcessed = status.processed + status.skipped;
      const percent = status.total > 0 ? Math.round((totalProcessed / status.total) * 100) : 0;
      progressFill.style.width = percent + '%';
      progressText.textContent = `${totalProcessed} / ${status.total} orders`;
      progressPercent.textContent = percent + '%';

      // Update Page and Order progress display
      if (pageProgress && orderProgress) {
        pageProgress.textContent = `${status.currentPage || 1}/${status.totalPages || 1}`;
        orderProgress.textContent = `${status.currentOrderInPage || 0}/${status.ordersInPage || 0}`;
      }

      statsGrid.style.display = 'grid';
      successCount.textContent = status.success || 0;
      failedCount.textContent = status.failed || 0;
      skippedCount.textContent = status.skipped || 0;
      remainingCount.textContent = status.remaining || 0;
    }
    return;
  }

  if (status.isRunning) {
    setRunningState(true);
    statusIcon.textContent = '⏳';
    statusText.textContent = status.message || 'Processing orders...';
    statusText.classList.add('running');

    // Track start time for estimation
    if (!exportStartTime) {
      exportStartTime = Date.now();
    }

    // Show progress
    progressSection.classList.add('show');
    const totalProcessed = status.processed + status.skipped;
    const percent = status.total > 0 ? Math.round((totalProcessed / status.total) * 100) : 0;
    progressFill.style.width = percent + '%';
    progressText.textContent = `${totalProcessed} / ${status.total} orders`;
    progressPercent.textContent = percent + '%';

    // Update Page and Order progress display
    if (pageProgress && orderProgress) {
      pageProgress.textContent = `${status.currentPage || 1}/${status.totalPages || 1}`;
      orderProgress.textContent = `${status.currentOrderInPage || 0}/${status.ordersInPage || 0}`;
    }

    // Show time estimate
    const estimate = calculateTimeEstimate(totalProcessed, status.total, status.remaining);
    if (estimate && timeEstimate && timeRemaining) {
      timeEstimate.style.display = 'block';
      timeRemaining.textContent = estimate;
    }

    // Show current order
    if (status.currentOrderId) {
      currentOrder.classList.add('show');
      currentOrderId.textContent = status.currentOrderId;
    }

    // Show stats during processing
    statsGrid.style.display = 'grid';
    successCount.textContent = status.success || 0;
    failedCount.textContent = status.failed || 0;
    skippedCount.textContent = status.skipped || 0;
    remainingCount.textContent = status.remaining || 0;

  } else {
    setRunningState(false);
    statusText.classList.remove('running');
    currentOrder.classList.remove('show');

    // Hide time estimate when not running
    if (timeEstimate) {
      timeEstimate.style.display = 'none';
    }

    // Reset start time
    exportStartTime = null;

    if (status.completed) {
      statusIcon.textContent = '✅';
      statusText.textContent = 'Export completed!';
      // Keep progress and stats visible
      if (hasData) {
        progressSection.classList.add('show');
        statsGrid.style.display = 'grid';
      }
    } else if (status.stopped) {
      statusIcon.textContent = '⏸️';
      statusText.textContent = 'Export paused';
      // Keep progress and stats visible
      if (hasData) {
        progressSection.classList.add('show');
        statsGrid.style.display = 'grid';
      }
      // Show resume option
      checkPreviousSession();
    } else {
      statusIcon.textContent = '📦';
      statusText.textContent = 'Ready to export orders';
    }
  }

  // Update stats if we have any
  if (hasData) {
    successCount.textContent = status.success || 0;
    failedCount.textContent = status.failed || 0;
    skippedCount.textContent = status.skipped || 0;
    remainingCount.textContent = status.remaining || 0;
  }

  // Update storage count
  updateStorageCount();
}

// Set running/stopped/paused state
function setRunningState(running, paused = false) {
  isRunning = running;

  if (paused) {
    // Paused state - show resume/stop buttons
    startBtn.style.display = 'none';
    runningBtns.style.display = 'none';
    pausedBtns.style.display = 'flex';
    historySection.classList.remove('show');
    settingsSection.style.display = 'none';
    logSection.classList.add('show');
  } else if (running) {
    // Running state
    startBtn.style.display = 'none';
    runningBtns.style.display = 'flex';
    pausedBtns.style.display = 'none';
    historySection.classList.remove('show');
    settingsSection.style.display = 'none';
    logSection.classList.add('show');
  } else {
    // Stopped state
    startBtn.style.display = 'block';
    runningBtns.style.display = 'none';
    pausedBtns.style.display = 'none';
    settingsSection.style.display = 'block';
  }
}

// Add log entry
function addLog(text, level = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + level;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logSection.insertBefore(entry, logSection.firstChild);

  // Keep only last 50 entries
  while (logSection.children.length > 50) {
    logSection.removeChild(logSection.lastChild);
  }

  logSection.classList.add('show');
}

// Initialize
init();
