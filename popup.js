/**
 * Popup Script for TikTok Order Exporter
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
const totalCollected = document.getElementById('totalCollected');
const successCount = document.getElementById('successCount');
const failedCount = document.getElementById('failedCount');
const totalAmount = document.getElementById('totalAmount');
const startBtn = document.getElementById('startBtn');
const actionBtns = document.getElementById('actionBtns');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const maxOrdersInput = document.getElementById('maxOrders');
const delayMsInput = document.getElementById('delayMs');
const logSection = document.getElementById('logSection');

// State
let isRunning = false;

// Load saved settings
chrome.storage.local.get(['maxOrders', 'delayMs'], (result) => {
  if (result.maxOrders) maxOrdersInput.value = result.maxOrders;
  if (result.delayMs) delayMsInput.value = result.delayMs;
});

// Save settings on change
maxOrdersInput.addEventListener('change', () => {
  chrome.storage.local.set({ maxOrders: parseInt(maxOrdersInput.value) });
});

delayMsInput.addEventListener('change', () => {
  chrome.storage.local.set({ delayMs: parseInt(delayMsInput.value) });
});

// Check current status on popup open
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
  if (response) {
    updateUI(response);
  }
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
  const delayMs = parseInt(delayMsInput.value) || 2000;

  // Send start command to background
  chrome.runtime.sendMessage({
    type: 'START_EXPORT',
    maxOrders,
    delayMs
  }, (response) => {
    if (response && response.success) {
      setRunningState(true);
      addLog('Export started...', 'info');
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

// Download button click
downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_EXCEL' }, (response) => {
    if (response && response.success) {
      addLog('Excel file downloaded!', 'success');
    } else if (response && response.error) {
      addLog('Download error: ' + response.error, 'error');
    }
  });
});

// Update UI based on status
function updateUI(status) {
  isRunning = status.isRunning;

  if (status.isRunning) {
    setRunningState(true);
    statusIcon.textContent = '⏳';
    statusText.textContent = status.message || 'Processing orders...';
    statusText.classList.add('running');

    // Show progress
    progressSection.classList.add('show');
    const percent = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
    progressFill.style.width = percent + '%';
    progressText.textContent = `${status.processed} / ${status.total} orders`;
    progressPercent.textContent = percent + '%';

    // Show current order
    if (status.currentOrderId) {
      currentOrder.classList.add('show');
      currentOrderId.textContent = status.currentOrderId;
    }
  } else {
    setRunningState(false);
    statusText.classList.remove('running');

    if (status.completed) {
      statusIcon.textContent = '✅';
      statusText.textContent = 'Export completed!';
      downloadBtn.disabled = false;
    } else if (status.stopped) {
      statusIcon.textContent = '⏹';
      statusText.textContent = 'Export stopped';
      if (status.collected > 0) {
        downloadBtn.disabled = false;
      }
    } else {
      statusIcon.textContent = '📦';
      statusText.textContent = 'Ready to export orders';
    }

    currentOrder.classList.remove('show');
  }

  // Update stats
  if (status.collected > 0 || status.success > 0 || status.failed > 0) {
    statsGrid.style.display = 'grid';
    totalCollected.textContent = status.collected || 0;
    successCount.textContent = status.success || 0;
    failedCount.textContent = status.failed || 0;
    totalAmount.textContent = formatCurrency(status.totalAmount || 0);
  }

  // Enable download if we have data
  if (status.collected > 0 && !status.isRunning) {
    downloadBtn.disabled = false;
  }
}

// Set running/stopped state
function setRunningState(running) {
  isRunning = running;

  if (running) {
    startBtn.style.display = 'none';
    actionBtns.style.display = 'flex';
    downloadBtn.disabled = true;
    maxOrdersInput.disabled = true;
    delayMsInput.disabled = true;
    logSection.classList.add('show');
  } else {
    startBtn.style.display = 'block';
    actionBtns.style.display = 'none';
    maxOrdersInput.disabled = false;
    delayMsInput.disabled = false;
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

// Format currency
function formatCurrency(amount) {
  return 'RM ' + parseFloat(amount || 0).toFixed(2);
}
