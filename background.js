/**
 * Background Service Worker for TikTok Order Exporter
 * v2.9.1 - Added watchdog timer for stalled processing
 *
 * Flow:
 * 1. Open TikTok Seller Center → Shipped tab
 * 2. Collect order IDs from the list page
 * 3. Go to each order detail page
 * 4. Click reveal buttons to unmask data
 * 5. Extract customer data
 * 6. Store in chrome.storage.local (persistent)
 * 7. Export to CSV or XLSX anytime
 */

// Import SheetJS library for XLSX export
importScripts('lib/xlsx.full.min.js');

// Constants
const MAX_RETRIES = 3;
const NOTIFICATION_ID = 'tiktok-export-complete';
const DEBUG = false; // Set to true for verbose logging
const ORDER_TIMEOUT_MS = 30000; // 30 seconds max per order before auto-refresh

// Debug logger
function debugLog(...args) {
  if (DEBUG) console.log('[Background]', ...args);
}

// Watchdog timer for detecting stalled processing
let orderWatchdogTimer = null;
let orderStartTime = null;

// State
let state = {
  isRunning: false,
  shouldStop: false,
  isPaused: false, // New: pause state (human-initiated, no auto-resume)
  pausedByHuman: false, // New: track if paused by user
  currentTabId: null,
  maxOrders: 100,
  delayMinMs: 2000,
  delayMaxMs: 7000,
  orderIds: [],
  collectedData: [],
  existingOrderIds: [],
  currentOrderIndex: 0,
  processed: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  totalAmount: 0,
  isProcessingOrder: false,
  phase: 'idle', // idle, collecting, processing, done, paused
  retryCount: {}, // Track retry attempts per order: { orderId: attemptCount }
  retried: 0, // Count of orders that succeeded after retry
  dateFilter: null // Optional date filter: { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
};

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog('Message:', message.type);

  switch (message.type) {
    case 'START_EXPORT':
      handleStart(message).then(sendResponse);
      return true;

    case 'RESUME_EXPORT':
      handleResume(message).then(sendResponse);
      return true;

    case 'PAUSE_EXPORT':
      handlePause();
      sendResponse({ paused: true });
      return false;

    case 'RESUME_PAUSED':
      handleResumePaused().then(sendResponse);
      return true;

    case 'STOP_EXPORT':
      handleStop();
      sendResponse({ stopped: true });
      return false;

    case 'GET_STATUS':
      sendResponse(getStatus());
      return false;

    case 'DOWNLOAD_CSV':
      downloadCSV().then(sendResponse);
      return true;

    case 'DOWNLOAD_XLSX':
      downloadXLSX().then(sendResponse);
      return true;

    case 'GET_EXPORT_HISTORY':
      getExportHistory().then(sendResponse);
      return true;

    case 'ORDER_IDS_COLLECTED':
      handleOrderIdsCollected(message.orderIds, message.actualMaxPages);
      sendResponse({ success: true });
      return false;

    case 'ORDER_DATA_EXTRACTED':
      handleOrderDataExtracted(message.data);
      sendResponse({ success: true });
      return false;
  }
});

// Flag to prevent multiple collect calls
let collectCalled = false;

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === state.currentTabId && changeInfo.status === 'complete' && state.isRunning) {
    debugLog('Tab loaded:', tab.url);

    setTimeout(() => {
      if (!state.isRunning || state.shouldStop) return;

      if (state.phase === 'collecting' && tab.url.includes('/order') && !tab.url.includes('/detail')) {
        // Only call collect once per session
        if (!collectCalled) {
          collectCalled = true;
          collectOrderIds();
        } else {
          debugLog('collectOrderIds already called, skipping');
        }
      } else if (state.phase === 'processing' && tab.url.includes('/order/detail')) {
        if (!state.isProcessingOrder) {
          processCurrentOrder();
        }
      }
    }, 2000);
  }
});

/**
 * Handle start command (fresh start)
 */
async function handleStart(message) {
  if (state.isRunning) {
    return { error: 'Already running' };
  }

  // Reset collect flag for new session
  collectCalled = false;

  // Load existing orders from storage
  const storage = await chrome.storage.local.get(['exportedOrders']);
  const existingOrderIds = storage.exportedOrders ? storage.exportedOrders.map(o => o.order_id) : [];

  // Reset state
  state = {
    isRunning: true,
    shouldStop: false,
    currentTabId: null,
    startPage: message.startPage || 1,
    endPage: message.endPage || 1,
    currentPage: message.startPage || 1, // Track current page being processed
    delayMinMs: message.delayMinMs || 2000,
    delayMaxMs: message.delayMaxMs || 6000,
    orderIds: [],
    collectedData: [],
    existingOrderIds: existingOrderIds,
    currentOrderIndex: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    totalAmount: 0,
    isProcessingOrder: false,
    phase: 'collecting',
    retryCount: {},
    retried: 0,
    dateFilter: message.dateFilter || null // Store date filter (single date)
  };

  // Log date filter if present
  if (state.dateFilter) {
    log(`Date: ${state.dateFilter.date}, Pages: ${state.startPage}-${state.endPage}`);
  }

  // Clear previous session
  await chrome.storage.local.remove(['sessionState']);

  broadcastStatus('Opening TikTok Seller Center...');
  log(`Starting export... (${existingOrderIds.length} orders already in storage)`);

  try {
    const tab = await chrome.tabs.create({
      url: 'https://seller-my.tiktok.com/order?selected_sort=6&tab=shipped',
      active: true
    });
    state.currentTabId = tab.id;

    return { success: true };
  } catch (error) {
    state.isRunning = false;
    log('Error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Handle resume command (continue from previous session)
 */
async function handleResume(message) {
  if (state.isRunning) {
    return { error: 'Already running' };
  }

  // Load session state
  const sessionData = await chrome.storage.local.get(['sessionState', 'exportedOrders']);
  const session = sessionData.sessionState;

  if (!session || !session.orderIds || session.orderIds.length === 0) {
    return { error: 'No previous session found' };
  }

  const existingOrderIds = sessionData.exportedOrders ? sessionData.exportedOrders.map(o => o.order_id) : [];

  // Restore state from session
  state = {
    isRunning: true,
    shouldStop: false,
    currentTabId: null,
    maxOrders: session.maxOrders || 100,
    delayMinMs: message.delayMinMs || 2000,
    delayMaxMs: message.delayMaxMs || 6000,
    orderIds: session.orderIds,
    collectedData: [],
    existingOrderIds: existingOrderIds,
    currentOrderIndex: session.currentOrderIndex || 0,
    processed: session.processed || 0,
    success: session.success || 0,
    failed: session.failed || 0,
    skipped: session.skipped || 0,
    totalAmount: session.totalAmount || 0,
    isProcessingOrder: false,
    phase: 'processing',
    retryCount: session.retryCount || {},
    retried: session.retried || 0
  };

  const remaining = state.orderIds.length - state.currentOrderIndex;
  broadcastStatus(`Resuming... ${remaining} orders remaining`);
  log(`Resuming export from order ${state.currentOrderIndex + 1}/${state.orderIds.length}`);

  try {
    // Close any existing TikTok Seller Center tabs (they may be stale/expired)
    const existingTabs = await chrome.tabs.query({ url: '*://seller-my.tiktok.com/*' });
    for (const tab of existingTabs) {
      try {
        await chrome.tabs.remove(tab.id);
        log('Closed stale TikTok tab');
      } catch (e) {
        // Tab may already be closed
      }
    }

    // Open a fresh new tab
    const tab = await chrome.tabs.create({
      url: 'https://seller-my.tiktok.com/order?tab=shipped',
      active: true
    });
    state.currentTabId = tab.id;
    log('Opened fresh TikTok tab');

    // Wait for tab to fully load then start processing
    setTimeout(() => {
      if (state.isRunning && !state.shouldStop) {
        processNextOrder();
      }
    }, 4000);

    return { success: true };
  } catch (error) {
    state.isRunning = false;
    log('Error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Handle pause command (HUMAN PAUSE - no auto-resume)
 */
function handlePause() {
  state.isPaused = true;
  state.pausedByHuman = true;
  state.isRunning = false;

  // Stop watchdog timer
  stopOrderWatchdog();

  // Save session state (but mark as paused by human)
  saveSessionState();

  broadcastStatus('Export paused by user', false, false, false, null, true);
  log('Export paused by user - manual resume required');
}

/**
 * Handle resume from paused state
 */
async function handleResumePaused() {
  if (!state.isPaused) {
    return { error: 'Not paused' };
  }

  state.isPaused = false;
  state.pausedByHuman = false;
  state.isRunning = true;

  broadcastStatus('Resuming export...');
  log('Resuming from pause...');

  // Continue processing
  processNextOrder();

  return { success: true };
}

/**
 * Handle stop command (FORCE STOP - no auto-resume)
 */
async function handleStop() {
  state.shouldStop = true;
  state.isRunning = false;
  state.isPaused = false;
  state.pausedByHuman = false;

  // Stop watchdog timer
  stopOrderWatchdog();

  // FORCE STOP: Clear session state so it won't auto-resume
  await clearSessionState();

  broadcastStatus('Export stopped', false, true);
  log('Export force stopped - session cleared');
}

/**
 * Save current session state for resume
 */
async function saveSessionState() {
  if (state.orderIds.length > 0) {
    await chrome.storage.local.set({
      sessionState: {
        orderIds: state.orderIds,
        currentOrderIndex: state.currentOrderIndex,
        maxOrders: state.maxOrders,
        processed: state.processed,
        success: state.success,
        failed: state.failed,
        skipped: state.skipped,
        totalAmount: state.totalAmount,
        retryCount: state.retryCount,
        retried: state.retried,
        pausedByHuman: state.pausedByHuman, // Track if paused by user
        savedAt: new Date().toISOString()
      }
    });
    debugLog('Session state saved');
  }
}

/**
 * Clear session state (when completed)
 */
async function clearSessionState() {
  await chrome.storage.local.remove(['sessionState']);
  debugLog('Session state cleared');
}

/**
 * Collect order IDs from list page
 */
async function collectOrderIds() {
  if (!state.isRunning || state.shouldStop) return;

  const currentPage = state.currentPage || state.startPage;
  log(`Collecting order IDs from page ${currentPage}...`);
  broadcastStatus(`Collecting orders from page ${currentPage}...`);

  try {
    // Build message with page number and date filter
    const message = {
      type: 'COLLECT_ORDER_IDS',
      pageNumber: currentPage,
      dateFilter: state.dateFilter
    };

    if (state.dateFilter) {
      log(`Date: ${state.dateFilter.date}, Page: ${currentPage}`);
    }

    await chrome.tabs.sendMessage(state.currentTabId, message);
  } catch (error) {
    log('Error collecting order IDs: ' + error.message, 'error');
    handleStop();
  }
}

/**
 * Handle collected order IDs from content script
 */
async function handleOrderIdsCollected(orderIds, actualMaxPages = null) {
  if (!state.isRunning || state.shouldStop) return;

  state.orderIds = orderIds;
  const currentPage = state.currentPage;

  // Adjust endPage if actualMaxPages is less than user-requested endPage
  // This handles cases where filtered results have fewer pages than expected
  if (actualMaxPages !== null && actualMaxPages > 0) {
    const originalEndPage = state.endPage;
    if (actualMaxPages < state.endPage) {
      state.endPage = actualMaxPages;
      log(`Adjusted end page from ${originalEndPage} to ${actualMaxPages} (actual available pages)`);
    }
    debugLog(`Actual max pages: ${actualMaxPages}, Using end page: ${state.endPage}`);
  }

  log(`Page ${currentPage}/${state.endPage}: Collected ${orderIds.length} order IDs`);

  if (orderIds.length === 0) {
    // No orders on this page, check if more pages to process
    if (currentPage < state.endPage) {
      log(`Page ${currentPage} empty, moving to next page...`);
      state.currentPage++;
      state.phase = 'collecting';
      collectCalled = false;

      // Navigate to order list page to collect next page
      setTimeout(async () => {
        if (state.isRunning && !state.shouldStop) {
          await chrome.tabs.update(state.currentTabId, {
            url: 'https://seller-my.tiktok.com/order?selected_sort=6&tab=shipped'
          });
        }
      }, 1000);
      return;
    }

    // All pages done
    log('No more orders found!');
    state.isRunning = false;
    state.phase = 'done';
    await clearSessionState();
    broadcastStatus('Export completed!', false, false, true);
    showCompletionNotification(state.success, state.failed, state.skipped, state.retried);
    return;
  }

  // Save session state
  await saveSessionState();

  // Start processing orders from this page
  state.phase = 'processing';
  state.currentOrderIndex = 0;
  broadcastStatus(`Page ${currentPage}/${state.endPage}: Processing ${orderIds.length} orders...`);

  processNextOrder();
}

/**
 * Process next order in queue
 */
async function processNextOrder() {
  if (state.shouldStop || !state.isRunning) return;

  // Skip orders that already exist in storage
  while (state.currentOrderIndex < state.orderIds.length) {
    const orderId = state.orderIds[state.currentOrderIndex];

    if (state.existingOrderIds.includes(orderId)) {
      const orderIdShort = orderId.slice(-8);
      log(`⏭ Skipping ...${orderIdShort} (already exported)`, 'info');
      state.skipped++;
      state.currentOrderIndex++;
      broadcastStatus();
      // Save progress
      await saveSessionState();
      continue;
    }

    break;
  }

  if (state.currentOrderIndex >= state.orderIds.length) {
    // Current page done - save data first
    stopOrderWatchdog();
    await saveToStorage();

    // Check if more pages to process
    if (state.currentPage < state.endPage) {
      log(`Page ${state.currentPage} completed! Moving to page ${state.currentPage + 1}...`);
      state.currentPage++;
      state.orderIds = [];
      state.currentOrderIndex = 0;
      state.phase = 'collecting';
      collectCalled = false;

      // Navigate back to order list to collect next page
      setTimeout(async () => {
        if (state.isRunning && !state.shouldStop) {
          await chrome.tabs.update(state.currentTabId, {
            url: 'https://seller-my.tiktok.com/order?selected_sort=6&tab=shipped'
          });
        }
      }, 1500);
      return;
    }

    // All pages done!
    state.isRunning = false;
    state.phase = 'done';
    const retriedMsg = state.retried > 0 ? `, ${state.retried} recovered by retry` : '';
    log(`Export completed! ${state.success} success, ${state.failed} failed, ${state.skipped} skipped${retriedMsg}`);
    broadcastStatus('Export completed!', false, false, true);

    // Show desktop notification
    showCompletionNotification(state.success, state.failed, state.skipped, state.retried);

    await clearSessionState();
    return;
  }

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);
  const remaining = state.orderIds.length - state.currentOrderIndex - state.skipped;

  log(`Processing order ...${orderIdShort} (${state.currentOrderIndex + 1}/${state.orderIds.length}, ${remaining} remaining)`);
  broadcastStatus(`Processing order ${state.currentOrderIndex + 1}/${state.orderIds.length}`, true, false, false, orderId);

  // Start watchdog timer to detect stalled processing
  startOrderWatchdog(orderId);

  // Navigate to order detail page
  const url = `https://seller-my.tiktok.com/order/detail?order_no=${orderId}&shop_region=MY`;

  try {
    await chrome.tabs.update(state.currentTabId, { url });
  } catch (error) {
    stopOrderWatchdog();
    log('Navigation error: ' + error.message, 'error');
    handleOrderFailed(orderId, 'Navigation failed');
  }
}

/**
 * Process current order (after page load)
 */
async function processCurrentOrder() {
  if (state.shouldStop || !state.isRunning) return;
  if (state.currentOrderIndex >= state.orderIds.length) return;

  if (state.isProcessingOrder) {
    debugLog('Already processing, skipping');
    return;
  }
  state.isProcessingOrder = true;

  const orderId = state.orderIds[state.currentOrderIndex];

  try {
    await sleep(1500);

    await chrome.tabs.sendMessage(state.currentTabId, {
      type: 'EXTRACT_ORDER_DATA',
      orderId
    });
  } catch (error) {
    log('Extraction error: ' + error.message, 'error');
    handleOrderFailed(orderId, error.message);
  }
}

/**
 * Handle extracted order data from content script
 */
async function handleOrderDataExtracted(data) {
  // Stop watchdog - we got a response
  stopOrderWatchdog();

  if (!state.isRunning) return;

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);
  const currentRetries = state.retryCount[orderId] || 0;

  if (data && data.hasData && !data.isMasked) {
    // Success!
    if (currentRetries > 0) {
      state.retried++; // Track orders recovered by retry
      log(`✓ Order ...${orderIdShort}: ${data.name} (recovered after ${currentRetries} retry)`, 'success');
    } else {
      log(`✓ Order ...${orderIdShort}: ${data.name}`, 'success');
    }

    state.success++;
    state.collectedData.push({
      page: state.currentPage || 1, // Add page number as first column
      order_id: orderId,
      shipping_method: data.shipping_method || '',
      payment_method: data.payment_method || '',
      total_amount: data.total_amount || 0,
      currency: data.currency || 'MYR',
      items: data.items || '',
      sku_id: data.sku_id || '',
      customer_name: data.name || '',
      phone_number: data.phone_number || '',
      full_address: data.full_address || '',
      order_status: data.status || '',
      order_date: data.order_date || '',
      extracted_at: new Date().toISOString()
    });

    state.totalAmount += parseFloat(data.total_amount || 0);

    // Save to storage immediately (for live CSV export)
    await saveToStorage();

    // Move to next order
    state.processed++;
    state.currentOrderIndex++;
    state.isProcessingOrder = false;
  } else {
    // Check if this order should skip retry (privacy blocked by TikTok)
    const shouldSkipRetry = data && data.skipRetry === true;

    if (shouldSkipRetry) {
      // Privacy blocked - TikTok doesn't allow access, don't retry
      log(`✗ Order ...${orderIdShort}: BLOCKED by TikTok privacy (no retry)`, 'error');
      state.failed++;
      state.processed++;
      state.currentOrderIndex++;
      state.isProcessingOrder = false;

      // Save session state
      await saveSessionState();

      // Broadcast and continue to next order
      broadcastStatus();
      scheduleNextOrder();
      return;
    }

    // Failed - check if we should retry
    if (currentRetries < MAX_RETRIES) {
      state.retryCount[orderId] = currentRetries + 1;
      log(`⟳ Order ...${orderIdShort}: Retry ${currentRetries + 1}/${MAX_RETRIES} (${data.error || 'Data masked'})`, 'warn');
      state.isProcessingOrder = false;

      // Save session state before retry
      await saveSessionState();

      // Wait longer before retry (increasing backoff)
      const retryDelay = 3000 + (currentRetries * 2000);
      log(`Waiting ${(retryDelay / 1000).toFixed(1)}s before retry...`, 'info');
      setTimeout(() => retryCurrentOrder(), retryDelay);
      return; // Don't proceed to next order yet
    } else {
      // Max retries exceeded - mark as failed
      state.failed++;
      log(`✗ Order ...${orderIdShort}: Failed after ${MAX_RETRIES} retries (${data.error || 'Data masked/unavailable'})`, 'error');

      // Move to next order
      state.processed++;
      state.currentOrderIndex++;
      state.isProcessingOrder = false;
    }
  }

  // Save session state
  await saveSessionState();

  broadcastStatus();

  // Check if we need a rest break (human-like behavior)
  const restBreak = checkRestBreak();
  if (restBreak > 0) {
    setTimeout(() => processNextOrder(), restBreak);
    return;
  }

  // Random delay between min and max (with occasional longer pauses)
  const delay = getRandomDelay();
  log(`Waiting ${(delay / 1000).toFixed(1)}s before next order...`, 'info');
  setTimeout(() => processNextOrder(), delay);
}

/**
 * Retry current order (reload page and try extraction again)
 */
async function retryCurrentOrder() {
  if (state.shouldStop || !state.isRunning) return;
  if (state.currentOrderIndex >= state.orderIds.length) return;

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);
  const retryNum = state.retryCount[orderId] || 1;

  log(`Retrying order ...${orderIdShort} (attempt ${retryNum}/${MAX_RETRIES})...`);
  broadcastStatus(`Retrying order ${state.currentOrderIndex + 1}/${state.orderIds.length} (attempt ${retryNum})`, true, false, false, orderId);

  // Navigate to order detail page again
  const url = `https://seller-my.tiktok.com/order/detail?order_no=${orderId}&shop_region=MY`;

  try {
    await chrome.tabs.update(state.currentTabId, { url });
  } catch (error) {
    log('Navigation error on retry: ' + error.message, 'error');
    handleOrderFailed(orderId, 'Navigation failed on retry');
  }
}

/**
 * Get random delay between min and max with human-like variation
 * Adds occasional longer pauses to simulate human behavior
 */
function getRandomDelay() {
  const baseDelay = state.delayMinMs + Math.random() * (state.delayMaxMs - state.delayMinMs);

  // 15% chance of a "thinking" pause (add 2-5 extra seconds)
  if (Math.random() < 0.15) {
    const thinkingPause = 2000 + Math.random() * 3000;
    debugLog('Adding thinking pause:', (thinkingPause / 1000).toFixed(1), 's');
    return baseDelay + thinkingPause;
  }

  // 5% chance of a "distraction" pause (add 8-15 extra seconds)
  if (Math.random() < 0.05) {
    const distractionPause = 8000 + Math.random() * 7000;
    debugLog('Adding distraction pause:', (distractionPause / 1000).toFixed(1), 's');
    return baseDelay + distractionPause;
  }

  return baseDelay;
}

/**
 * Check if we need a rest break (every 20-25 orders)
 * Returns delay in ms if break needed, 0 otherwise
 */
function checkRestBreak() {
  const ordersProcessed = state.success + state.failed;

  // Random interval between 20-25 orders
  const breakInterval = 20 + Math.floor(Math.random() * 6);

  if (ordersProcessed > 0 && ordersProcessed % breakInterval === 0) {
    // Take a 10-20 second break
    const breakDuration = 10000 + Math.random() * 10000;
    log(`Short break... (${Math.round(breakDuration / 1000)}s)`, 'info');
    return breakDuration;
  }

  return 0;
}

/**
 * Save collected data to chrome.storage.local
 */
async function saveToStorage() {
  if (state.collectedData.length === 0) return;

  try {
    const storage = await chrome.storage.local.get(['exportedOrders']);
    const existingOrders = storage.exportedOrders || [];

    const existingIds = new Set(existingOrders.map(o => o.order_id));
    const newOrders = state.collectedData.filter(o => !existingIds.has(o.order_id));

    if (newOrders.length === 0) return;

    const allOrders = [...existingOrders, ...newOrders];

    await chrome.storage.local.set({ exportedOrders: allOrders });

    // Update existing IDs list
    state.existingOrderIds = allOrders.map(o => o.order_id);

    // Clear collectedData since it's now saved
    state.collectedData = [];

    log(`Saved ${newOrders.length} new orders (total: ${allOrders.length})`);
  } catch (error) {
    log('Failed to save: ' + error.message, 'error');
  }
}

/**
 * Handle order failure
 */
async function handleOrderFailed(orderId, reason) {
  const orderIdShort = orderId.slice(-8);
  const currentRetries = state.retryCount[orderId] || 0;

  // Check if we should retry
  if (currentRetries < MAX_RETRIES) {
    state.retryCount[orderId] = currentRetries + 1;
    log(`⟳ Order ...${orderIdShort}: Retry ${currentRetries + 1}/${MAX_RETRIES} (${reason})`, 'warn');
    state.isProcessingOrder = false;

    // Save session state before retry
    await saveSessionState();

    // Wait longer before retry (increasing backoff)
    const retryDelay = 3000 + (currentRetries * 2000);
    log(`Waiting ${(retryDelay / 1000).toFixed(1)}s before retry...`, 'info');
    setTimeout(() => retryCurrentOrder(), retryDelay);
    return;
  }

  // Max retries exceeded
  state.failed++;
  state.processed++;
  state.currentOrderIndex++;
  state.isProcessingOrder = false;

  log(`✗ Order ...${orderIdShort}: Failed after ${MAX_RETRIES} retries (${reason})`, 'error');

  // Save session state
  await saveSessionState();

  broadcastStatus();

  setTimeout(() => processNextOrder(), 1000);
}

/**
 * Get export history
 */
async function getExportHistory() {
  try {
    const storage = await chrome.storage.local.get(['exportHistory']);
    return { success: true, history: storage.exportHistory || [] };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Save export to history
 */
async function saveExportHistory(format, count, filename) {
  try {
    const storage = await chrome.storage.local.get(['exportHistory']);
    const history = storage.exportHistory || [];

    // Add new export record
    history.unshift({
      id: Date.now(),
      format: format,
      count: count,
      filename: filename,
      exportedAt: new Date().toISOString()
    });

    // Keep only last 50 exports
    if (history.length > 50) {
      history.length = 50;
    }

    await chrome.storage.local.set({ exportHistory: history });
    debugLog('Export history saved');
  } catch (error) {
    debugLog('Failed to save export history:', error);
  }
}

/**
 * Get order data headers
 */
function getExportHeaders() {
  return [
    'Page',
    'Order ID',
    'Shipping Method',
    'Payment Method',
    'Total',
    'Item (Full)',
    'SKU ID',
    'Customer Name',
    'Customer Phone',
    'Customer Address',
    'Date Order'
  ];
}

/**
 * Get order data rows (without CSV quoting)
 */
function getExportRows(orders) {
  return orders.map(row => [
    row.page || 1,
    row.order_id || '',
    row.shipping_method || '',
    row.payment_method || '',
    `${row.currency || 'MYR'} ${row.total_amount || 0}`,
    row.items || '',
    row.sku_id || '',
    row.customer_name || '',
    row.phone_number || '',
    row.full_address || '',
    row.order_date || ''
  ]);
}

/**
 * Download collected data as CSV
 * Note: Service workers don't have URL.createObjectURL, so we use data URL
 */
async function downloadCSV() {
  const storage = await chrome.storage.local.get(['exportedOrders']);
  const allOrders = storage.exportedOrders || [];

  if (allOrders.length === 0) {
    return { error: 'No data to download' };
  }

  try {
    const headers = getExportHeaders();
    const rows = getExportRows(allOrders);

    // CSV format with proper quoting
    const csvRows = rows.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    );

    const csvContent = [
      headers.map(h => `"${h}"`).join(','),
      ...csvRows
    ].join('\n');

    // Add BOM for Excel UTF-8 compatibility and encode as base64 data URL
    const BOM = '\uFEFF';
    const csvWithBOM = BOM + csvContent;

    // Convert to base64 data URL (service workers don't have URL.createObjectURL)
    const base64 = btoa(unescape(encodeURIComponent(csvWithBOM)));
    const dataUrl = `data:text/csv;charset=utf-8;base64,${base64}`;

    const filename = `tiktok_orders_${new Date().toISOString().split('T')[0]}_${allOrders.length}orders.csv`;

    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    });

    // Save to export history
    await saveExportHistory('CSV', allOrders.length, filename);

    log(`Downloaded ${filename} (${allOrders.length} orders)`);
    return { success: true, filename, count: allOrders.length };
  } catch (error) {
    log('CSV download error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Download collected data as Excel XLSX
 * Uses SheetJS library
 */
async function downloadXLSX() {
  const storage = await chrome.storage.local.get(['exportedOrders']);
  const allOrders = storage.exportedOrders || [];

  if (allOrders.length === 0) {
    return { error: 'No data to download' };
  }

  try {
    const headers = getExportHeaders();
    const rows = getExportRows(allOrders);

    // Create worksheet data (headers + rows)
    const wsData = [headers, ...rows];

    // Create worksheet
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Set column widths for better readability
    ws['!cols'] = [
      { wch: 6 },   // Page
      { wch: 20 },  // Order ID
      { wch: 15 },  // Shipping Method
      { wch: 15 },  // Payment Method
      { wch: 12 },  // Total
      { wch: 40 },  // Item (Full)
      { wch: 15 },  // SKU ID
      { wch: 25 },  // Customer Name
      { wch: 15 },  // Customer Phone
      { wch: 50 },  // Customer Address
      { wch: 12 }   // Date Order
    ];

    // Create workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');

    // Generate XLSX binary
    const xlsxBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });

    // Create data URL
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsxBinary}`;

    const filename = `tiktok_orders_${new Date().toISOString().split('T')[0]}_${allOrders.length}orders.xlsx`;

    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    });

    // Save to export history
    await saveExportHistory('XLSX', allOrders.length, filename);

    log(`Downloaded ${filename} (${allOrders.length} orders)`);
    return { success: true, filename, count: allOrders.length };
  } catch (error) {
    log('XLSX download error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Get current status
 */
function getStatus() {
  const remaining = state.orderIds.length - state.currentOrderIndex;
  const currentOrderId = state.orderIds[state.currentOrderIndex];
  const currentRetry = currentOrderId ? (state.retryCount[currentOrderId] || 0) : 0;
  return {
    isRunning: state.isRunning,
    isPaused: state.isPaused,
    pausedByHuman: state.pausedByHuman,
    phase: state.phase,
    total: state.orderIds.length,
    processed: state.processed,
    collected: state.collectedData.length,
    success: state.success,
    failed: state.failed,
    skipped: state.skipped,
    retried: state.retried,
    remaining: remaining > 0 ? remaining : 0,
    totalAmount: state.totalAmount,
    currentOrderId: currentOrderId,
    currentRetry: currentRetry,
    stopped: state.shouldStop && !state.isRunning,
    completed: state.phase === 'done' && !state.isRunning,
    // Page progress info
    currentPage: state.currentPage || 1,
    totalPages: state.endPage || 1,
    startPage: state.startPage || 1,
    // Current order index within page (1-based)
    currentOrderInPage: state.currentOrderIndex + 1,
    ordersInPage: state.orderIds.length
  };
}

/**
 * Broadcast status to popup
 */
function broadcastStatus(message = null, running = null, stopped = false, completed = false, currentOrderId = null, paused = false) {
  const status = getStatus();
  if (message) status.message = message;
  if (running !== null) status.isRunning = running;
  if (stopped) status.stopped = true;
  if (completed) status.completed = true;
  if (currentOrderId) status.currentOrderId = currentOrderId;
  if (paused) status.isPaused = true;

  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', ...status }).catch(() => {});
}

/**
 * Send log to popup
 */
function log(text, level = 'info') {
  if (DEBUG) console.log(`[Background] ${text}`);
  chrome.runtime.sendMessage({ type: 'LOG', text, level }).catch(() => {});
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Start watchdog timer for order processing
 * If order takes longer than ORDER_TIMEOUT_MS, auto-refresh and retry
 */
function startOrderWatchdog(orderId) {
  // Clear any existing watchdog
  stopOrderWatchdog();

  orderStartTime = Date.now();
  const orderIdShort = orderId.slice(-8);

  orderWatchdogTimer = setTimeout(async () => {
    if (!state.isRunning || state.shouldStop) return;

    const elapsed = Math.round((Date.now() - orderStartTime) / 1000);
    log(`⚠ Order ...${orderIdShort} stalled (${elapsed}s) - auto-refreshing tab...`, 'warn');

    // Reset processing flag
    state.isProcessingOrder = false;

    // Refresh the tab to recover
    try {
      if (state.currentTabId) {
        await chrome.tabs.reload(state.currentTabId);
        log('Tab refreshed, will resume via tab update listener', 'info');
      }
    } catch (error) {
      log('Failed to refresh tab: ' + error.message, 'error');
      // If tab refresh fails, try to handle as failed order
      handleOrderFailed(orderId, 'Processing timeout - tab refresh failed');
    }
  }, ORDER_TIMEOUT_MS);

  debugLog(`Watchdog started for order ...${orderIdShort} (${ORDER_TIMEOUT_MS}ms timeout)`);
}

/**
 * Stop/clear the watchdog timer
 */
function stopOrderWatchdog() {
  if (orderWatchdogTimer) {
    clearTimeout(orderWatchdogTimer);
    orderWatchdogTimer = null;
  }
  orderStartTime = null;
}

/**
 * Show desktop notification when export completes
 */
function showCompletionNotification(success, failed, skipped, retried = 0) {
  const total = success + failed + skipped;
  const retriedText = retried > 0 ? `, ${retried} recovered` : '';

  chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Export Complete!',
    message: `${success} orders exported successfully!\n${failed} failed, ${skipped} skipped${retriedText}`,
    priority: 2,
    requireInteraction: false
  });

  // Send message to popup to play sound
  chrome.runtime.sendMessage({
    type: 'PLAY_SOUND',
    sound: failed === 0 ? 'success' : 'warning'
  }).catch(() => {});
}

// Log service worker start
console.log('[Tiktok Aqil Az Exporter] Background service worker started v3.0.8');
