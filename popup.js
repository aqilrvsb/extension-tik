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
const stopBtn = document.getElementById('stopBtn');
const downloadCsvBtn = document.getElementById('downloadCsvBtn');
const downloadXlsxBtn = document.getElementById('downloadXlsxBtn');
const maxOrdersInput = document.getElementById('maxOrders');
const delayMinInput = document.getElementById('delayMin');
const delayMaxInput = document.getElementById('delayMax');
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

// Date filter elements
const enableDateFilter = document.getElementById('enableDateFilter');
const dateRangeInputs = document.getElementById('dateRangeInputs');
const filterStartDate = document.getElementById('filterStartDate');
const filterEndDate = document.getElementById('filterEndDate');

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
            // Method 1: Look for "Shop Code: XXXXX" text anywhere in page
            const bodyText = document.body.innerText;
            const shopCodeMatch = bodyText.match(/Shop\s*Code[:\s]+([A-Z0-9]{8,12})/i);
            if (shopCodeMatch) return shopCodeMatch[1];

            // Method 2: Look for spans/divs containing shop code pattern near "Shop Code" text
            const allElements = document.querySelectorAll('span, div, p');
            for (const el of allElements) {
              const text = el.textContent?.trim();
              // Look for element that contains "Shop Code:" followed by the code
              if (text && /Shop\s*Code/i.test(text)) {
                const codeMatch = text.match(/([A-Z]{2}[A-Z0-9]{6,10})/);
                if (codeMatch) return codeMatch[1];
              }
            }

            // Method 3: Look in URL params
            const urlMatch = window.location.href.match(/shop_code=([A-Z0-9]+)/i);
            if (urlMatch) return urlMatch[1];

            // Method 4: Look for MY-prefixed shop codes (Malaysia TikTok Shop pattern)
            const myCodeMatch = bodyText.match(/\b(MY[A-Z0-9]{6,10})\b/);
            if (myCodeMatch) return myCodeMatch[0];

            // Method 5: Look in page HTML for shop code pattern
            const pageHtml = document.body.innerHTML;
            // Match shop codes like MYLCV9LW68 (2 letter prefix + alphanumeric)
            const htmlCodeMatch = pageHtml.match(/\b([A-Z]{2}[A-Z0-9]{6,10})\b/);
            if (htmlCodeMatch) return htmlCodeMatch[1];

            // Method 6: Look for data attribute
            const shopElement = document.querySelector('[data-shop-code]');
            if (shopElement) return shopElement.getAttribute('data-shop-code');

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
        const validUntil = new Date(newLicense.valid_until);
        const now = new Date();
        const daysRemaining = Math.ceil((validUntil - now) / (1000 * 60 * 60 * 24));

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

    // Calculate days remaining
    const daysRemaining = Math.ceil((validUntil - now) / (1000 * 60 * 60 * 24));

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
  const settings = await chrome.storage.local.get(['maxOrders', 'delayMin', 'delayMax', 'enableDateFilter', 'filterStartDate', 'filterEndDate']);
  if (settings.maxOrders) maxOrdersInput.value = settings.maxOrders;
  if (settings.delayMin) delayMinInput.value = settings.delayMin;
  if (settings.delayMax) delayMaxInput.value = settings.delayMax;

  // Load date filter settings
  if (settings.enableDateFilter) {
    enableDateFilter.checked = true;
    dateRangeInputs.style.display = 'block';
  }
  if (settings.filterStartDate) filterStartDate.value = settings.filterStartDate;
  if (settings.filterEndDate) filterEndDate.value = settings.filterEndDate;

  // Set default dates if not set (last 30 days)
  if (!filterStartDate.value) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    filterStartDate.value = thirtyDaysAgo.toISOString().split('T')[0];
  }
  if (!filterEndDate.value) {
    filterEndDate.value = new Date().toISOString().split('T')[0];
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
async function checkPreviousSession() {
  const sessionData = await chrome.storage.local.get(['sessionState']);
  const session = sessionData.sessionState;

  if (session && session.orderIds && session.orderIds.length > 0 && session.currentOrderIndex < session.orderIds.length) {
    // There's an interrupted session (natural interruption, not force stop)
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
  const delayMin = parseFloat(delayMinInput.value) || 2;
  const delayMax = parseFloat(delayMaxInput.value) || 6;

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

// Save settings on change
maxOrdersInput.addEventListener('change', () => {
  chrome.storage.local.set({ maxOrders: parseInt(maxOrdersInput.value) });
});

delayMinInput.addEventListener('change', () => {
  let min = parseFloat(delayMinInput.value);
  let max = parseFloat(delayMaxInput.value);
  if (min > max) {
    delayMaxInput.value = min;
    max = min;
  }
  chrome.storage.local.set({ delayMin: min, delayMax: max });
});

delayMaxInput.addEventListener('change', () => {
  let min = parseFloat(delayMinInput.value);
  let max = parseFloat(delayMaxInput.value);
  if (max < min) {
    delayMinInput.value = max;
    min = max;
  }
  chrome.storage.local.set({ delayMin: min, delayMax: max });
});

// Date filter toggle
enableDateFilter.addEventListener('change', () => {
  const enabled = enableDateFilter.checked;
  dateRangeInputs.style.display = enabled ? 'block' : 'none';
  chrome.storage.local.set({ enableDateFilter: enabled });
});

// Date filter inputs
filterStartDate.addEventListener('change', () => {
  chrome.storage.local.set({ filterStartDate: filterStartDate.value });
});

filterEndDate.addEventListener('change', () => {
  chrome.storage.local.set({ filterEndDate: filterEndDate.value });
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
  // REQUIRE date filter to be enabled
  if (!enableDateFilter.checked) {
    addLog('Date filter is required! Please enable it and select date range.', 'error');
    // Highlight the date filter checkbox
    enableDateFilter.parentElement.style.animation = 'shake 0.5s';
    setTimeout(() => {
      enableDateFilter.parentElement.style.animation = '';
    }, 500);
    return;
  }

  // Validate date range is set
  if (!filterStartDate.value || !filterEndDate.value) {
    addLog('Please select both start and end dates.', 'error');
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
  const maxOrders = parseInt(maxOrdersInput.value) || 100;
  const delayMin = parseFloat(delayMinInput.value) || 2;
  const delayMax = parseFloat(delayMaxInput.value) || 6;

  // Build message with optional date filter
  const message = {
    type: 'START_EXPORT',
    maxOrders,
    delayMinMs: delayMin * 1000,
    delayMaxMs: delayMax * 1000
  };

  // Add date filter if enabled
  if (enableDateFilter.checked && filterStartDate.value && filterEndDate.value) {
    message.dateFilter = {
      startDate: filterStartDate.value, // Format: YYYY-MM-DD
      endDate: filterEndDate.value
    };
    addLog(`Date filter: ${filterStartDate.value} to ${filterEndDate.value}`, 'info');
  }

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
  const delayMin = parseFloat(delayMinInput.value) || 2;
  const delayMax = parseFloat(delayMaxInput.value) || 6;

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

// Stop button click
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_EXPORT' }, (response) => {
    addLog('Export stopped by user', 'info');
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

// Set running/stopped state
function setRunningState(running) {
  isRunning = running;

  if (running) {
    startBtn.style.display = 'none';
    runningBtns.style.display = 'flex';
    historySection.classList.remove('show');
    settingsSection.style.display = 'none';
    logSection.classList.add('show');
  } else {
    startBtn.style.display = 'block';
    runningBtns.style.display = 'none';
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
