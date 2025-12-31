/**
 * Popup Script for TikTok Order Exporter
 * v2.0.0 - With resume, progress during run, and delay range
 */

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
const downloadBtn = document.getElementById('downloadBtn');
const maxOrdersInput = document.getElementById('maxOrders');
const delayMinInput = document.getElementById('delayMin');
const delayMaxInput = document.getElementById('delayMax');
const logSection = document.getElementById('logSection');
const historySection = document.getElementById('historySection');
const historyInfo = document.getElementById('historyInfo');
const resumeBtn = document.getElementById('resumeBtn');
const historyDownloadBtn = document.getElementById('historyDownloadBtn');
const settingsSection = document.getElementById('settingsSection');
const storageCount = document.getElementById('storageCount');
const clearStorageBtn = document.getElementById('clearStorageBtn');
const openDashboardBtn = document.getElementById('openDashboardBtn');

// State
let isRunning = false;

// Initialize on popup open
async function init() {
  // Load saved settings
  const settings = await chrome.storage.local.get(['maxOrders', 'delayMin', 'delayMax']);
  if (settings.maxOrders) maxOrdersInput.value = settings.maxOrders;
  if (settings.delayMin) delayMinInput.value = settings.delayMin;
  if (settings.delayMax) delayMaxInput.value = settings.delayMax;

  // Load storage count
  await updateStorageCount();

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
async function checkPreviousSession() {
  const sessionData = await chrome.storage.local.get(['sessionState']);
  const session = sessionData.sessionState;

  if (session && session.orderIds && session.orderIds.length > 0 && session.currentOrderIndex < session.orderIds.length) {
    // There's an interrupted session - AUTO RESUME
    const remaining = session.orderIds.length - session.currentOrderIndex;
    const success = session.success || 0;
    const failed = session.failed || 0;

    console.log('[Popup] Found interrupted session, auto-resuming...');
    console.log('[Popup] Progress:', session.currentOrderIndex, '/', session.orderIds.length);

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
      console.log('[Popup] Auto-resume failed:', response.error);
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

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message) => {
  console.log('[Popup] Message:', message);

  if (message.type === 'STATUS_UPDATE') {
    updateUI(message);
  } else if (message.type === 'LOG') {
    addLog(message.text, message.level);
  }
});

// Start button click
startBtn.addEventListener('click', async () => {
  const maxOrders = parseInt(maxOrdersInput.value) || 100;
  const delayMin = parseFloat(delayMinInput.value) || 2;
  const delayMax = parseFloat(delayMaxInput.value) || 6;

  // Send start command to background
  chrome.runtime.sendMessage({
    type: 'START_EXPORT',
    maxOrders,
    delayMinMs: delayMin * 1000,
    delayMaxMs: delayMax * 1000
  }, (response) => {
    if (response && response.success) {
      setRunningState(true);
      addLog('Export started...', 'info');
      historySection.classList.remove('show');
    } else if (response && response.error) {
      addLog('Error: ' + response.error, 'error');
    }
  });
});

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

// Download button click (during processing or after)
downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_EXCEL' }, (response) => {
    if (response && response.success) {
      addLog(`Exported ${response.count} orders to CSV!`, 'success');
    } else if (response && response.error) {
      addLog('Download error: ' + response.error, 'error');
    }
  });
});

// History download button click
historyDownloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_EXCEL' }, (response) => {
    if (response && response.success) {
      addLog(`Exported ${response.count} orders to CSV!`, 'success');
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

    // Show progress
    progressSection.classList.add('show');
    const totalProcessed = status.processed + status.skipped;
    const percent = status.total > 0 ? Math.round((totalProcessed / status.total) * 100) : 0;
    progressFill.style.width = percent + '%';
    progressText.textContent = `${totalProcessed} / ${status.total} orders`;
    progressPercent.textContent = percent + '%';

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
