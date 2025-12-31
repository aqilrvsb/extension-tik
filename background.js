/**
 * Background Service Worker for TikTok Order Exporter
 * v2.0.0 - With resume, random delay, persistent state
 *
 * Flow:
 * 1. Open TikTok Seller Center → Shipped tab
 * 2. Collect order IDs from the list page
 * 3. Go to each order detail page
 * 4. Click reveal buttons to unmask data
 * 5. Extract customer data
 * 6. Store in chrome.storage.local (persistent)
 * 7. Export to CSV anytime
 */

// State
let state = {
  isRunning: false,
  shouldStop: false,
  currentTabId: null,
  maxOrders: 100,
  delayMinMs: 2000,
  delayMaxMs: 6000,
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
  phase: 'idle' // idle, collecting, processing, done
};

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Message:', message.type);

  switch (message.type) {
    case 'START_EXPORT':
      handleStart(message).then(sendResponse);
      return true;

    case 'RESUME_EXPORT':
      handleResume(message).then(sendResponse);
      return true;

    case 'STOP_EXPORT':
      handleStop();
      sendResponse({ stopped: true });
      return false;

    case 'GET_STATUS':
      sendResponse(getStatus());
      return false;

    case 'DOWNLOAD_EXCEL':
      downloadExcel().then(sendResponse);
      return true;

    case 'ORDER_IDS_COLLECTED':
      handleOrderIdsCollected(message.orderIds);
      sendResponse({ success: true });
      return false;

    case 'ORDER_DATA_EXTRACTED':
      handleOrderDataExtracted(message.data);
      sendResponse({ success: true });
      return false;
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === state.currentTabId && changeInfo.status === 'complete' && state.isRunning) {
    console.log('[Background] Tab loaded:', tab.url);

    setTimeout(() => {
      if (!state.isRunning || state.shouldStop) return;

      if (state.phase === 'collecting' && tab.url.includes('/order') && !tab.url.includes('/detail')) {
        collectOrderIds();
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

  // Load existing orders from storage
  const storage = await chrome.storage.local.get(['exportedOrders']);
  const existingOrderIds = storage.exportedOrders ? storage.exportedOrders.map(o => o.order_id) : [];

  // Reset state
  state = {
    isRunning: true,
    shouldStop: false,
    currentTabId: null,
    maxOrders: message.maxOrders || 100,
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
    phase: 'collecting'
  };

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
    phase: 'processing'
  };

  const remaining = state.orderIds.length - state.currentOrderIndex;
  broadcastStatus(`Resuming... ${remaining} orders remaining`);
  log(`Resuming export from order ${state.currentOrderIndex + 1}/${state.orderIds.length}`);

  try {
    // Open a new tab and start processing
    const tab = await chrome.tabs.create({
      url: 'https://seller-my.tiktok.com/order?tab=shipped',
      active: true
    });
    state.currentTabId = tab.id;

    // Wait for tab to load then start processing
    setTimeout(() => {
      if (state.isRunning && !state.shouldStop) {
        processNextOrder();
      }
    }, 3000);

    return { success: true };
  } catch (error) {
    state.isRunning = false;
    log('Error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Handle stop command
 */
async function handleStop() {
  state.shouldStop = true;
  state.isRunning = false;

  // Save session state for resume
  await saveSessionState();

  broadcastStatus('Export stopped', false, true);
  log('Export stopped - you can resume later');
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
        savedAt: new Date().toISOString()
      }
    });
    console.log('[Background] Session state saved');
  }
}

/**
 * Clear session state (when completed)
 */
async function clearSessionState() {
  await chrome.storage.local.remove(['sessionState']);
  console.log('[Background] Session state cleared');
}

/**
 * Collect order IDs from list page
 */
async function collectOrderIds() {
  if (!state.isRunning || state.shouldStop) return;

  log('Collecting order IDs from list page...');
  broadcastStatus('Collecting order IDs...');

  try {
    await chrome.tabs.sendMessage(state.currentTabId, {
      type: 'COLLECT_ORDER_IDS',
      maxOrders: state.maxOrders
    });
  } catch (error) {
    log('Error collecting order IDs: ' + error.message, 'error');
    handleStop();
  }
}

/**
 * Handle collected order IDs from content script
 */
async function handleOrderIdsCollected(orderIds) {
  if (!state.isRunning || state.shouldStop) return;

  state.orderIds = orderIds;
  log(`Collected ${orderIds.length} order IDs`);

  if (orderIds.length === 0) {
    log('No orders found!', 'error');
    state.isRunning = false;
    state.phase = 'done';
    await clearSessionState();
    broadcastStatus('No orders found', false, false, true);
    return;
  }

  // Save session state
  await saveSessionState();

  // Start processing orders
  state.phase = 'processing';
  state.currentOrderIndex = 0;
  broadcastStatus(`Processing ${orderIds.length} orders...`);

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
    // All done!
    state.isRunning = false;
    state.phase = 'done';
    log(`Export completed! ${state.success} success, ${state.failed} failed, ${state.skipped} skipped`);
    broadcastStatus('Export completed!', false, false, true);

    // Save collected data and clear session
    await saveToStorage();
    await clearSessionState();
    return;
  }

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);
  const remaining = state.orderIds.length - state.currentOrderIndex - state.skipped;

  log(`Processing order ...${orderIdShort} (${state.currentOrderIndex + 1}/${state.orderIds.length}, ${remaining} remaining)`);
  broadcastStatus(`Processing order ${state.currentOrderIndex + 1}/${state.orderIds.length}`, true, false, false, orderId);

  // Navigate to order detail page
  const url = `https://seller-my.tiktok.com/order/detail?order_no=${orderId}&shop_region=MY`;

  try {
    await chrome.tabs.update(state.currentTabId, { url });
  } catch (error) {
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
    console.log('[Background] Already processing, skipping');
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
  if (!state.isRunning) return;

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);

  if (data && data.hasData && !data.isMasked) {
    state.success++;
    state.collectedData.push({
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
    log(`✓ Order ...${orderIdShort}: ${data.name}`, 'success');

    // Save to storage immediately (for live CSV export)
    await saveToStorage();
  } else {
    state.failed++;
    log(`✗ Order ...${orderIdShort}: ${data.error || 'Data masked/unavailable'}`, 'error');
  }

  state.processed++;
  state.currentOrderIndex++;
  state.isProcessingOrder = false;

  // Save session state
  await saveSessionState();

  broadcastStatus();

  // Random delay between min and max
  const delay = getRandomDelay();
  log(`Waiting ${(delay / 1000).toFixed(1)}s before next order...`, 'info');
  setTimeout(() => processNextOrder(), delay);
}

/**
 * Get random delay between min and max
 */
function getRandomDelay() {
  return state.delayMinMs + Math.random() * (state.delayMaxMs - state.delayMinMs);
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
  state.failed++;
  state.processed++;
  state.currentOrderIndex++;
  state.isProcessingOrder = false;

  log(`✗ Order ...${orderIdShort}: ${reason}`, 'error');

  // Save session state
  await saveSessionState();

  broadcastStatus();

  setTimeout(() => processNextOrder(), 1000);
}

/**
 * Download collected data as CSV
 * Note: Service workers don't have URL.createObjectURL, so we use data URL
 */
async function downloadExcel() {
  const storage = await chrome.storage.local.get(['exportedOrders']);
  const allOrders = storage.exportedOrders || [];

  if (allOrders.length === 0) {
    return { error: 'No data to download' };
  }

  try {
    const headers = [
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

    const rows = allOrders.map(row => [
      row.order_id,
      `"${(row.shipping_method || '').replace(/"/g, '""')}"`,
      `"${(row.payment_method || '').replace(/"/g, '""')}"`,
      `${row.currency || 'MYR'} ${row.total_amount || 0}`,
      `"${(row.items || '').replace(/"/g, '""')}"`,
      `"${(row.sku_id || '').replace(/"/g, '""')}"`,
      `"${(row.customer_name || '').replace(/"/g, '""')}"`,
      row.phone_number || '',
      `"${(row.full_address || '').replace(/"/g, '""')}"`,
      row.order_date || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
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

    log(`Downloaded ${filename} (${allOrders.length} orders)`);
    return { success: true, filename, count: allOrders.length };
  } catch (error) {
    log('Download error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Get current status
 */
function getStatus() {
  const remaining = state.orderIds.length - state.currentOrderIndex;
  return {
    isRunning: state.isRunning,
    phase: state.phase,
    total: state.orderIds.length,
    processed: state.processed,
    collected: state.collectedData.length,
    success: state.success,
    failed: state.failed,
    skipped: state.skipped,
    remaining: remaining > 0 ? remaining : 0,
    totalAmount: state.totalAmount,
    currentOrderId: state.orderIds[state.currentOrderIndex],
    stopped: state.shouldStop && !state.isRunning,
    completed: state.phase === 'done' && !state.isRunning
  };
}

/**
 * Broadcast status to popup
 */
function broadcastStatus(message = null, running = null, stopped = false, completed = false, currentOrderId = null) {
  const status = getStatus();
  if (message) status.message = message;
  if (running !== null) status.isRunning = running;
  if (stopped) status.stopped = true;
  if (completed) status.completed = true;
  if (currentOrderId) status.currentOrderId = currentOrderId;

  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', ...status }).catch(() => {});
}

/**
 * Send log to popup
 */
function log(text, level = 'info') {
  console.log(`[Background] ${text}`);
  chrome.runtime.sendMessage({ type: 'LOG', text, level }).catch(() => {});
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Log service worker start
console.log('[TikTok Order Exporter] Background service worker started v2.0.0');
