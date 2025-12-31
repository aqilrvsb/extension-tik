/**
 * Background Service Worker for TikTok Order Exporter
 *
 * Flow:
 * 1. Open TikTok Seller Center → Shipped tab
 * 2. Collect order IDs from the list page
 * 3. Go to each order detail page
 * 4. Click reveal buttons to unmask data
 * 5. Extract customer data
 * 6. Store in memory
 * 7. Export to Excel when done
 */

// State
let state = {
  isRunning: false,
  shouldStop: false,
  currentTabId: null,
  maxOrders: 100,
  delayMs: 2000,
  orderIds: [],
  collectedData: [],
  currentOrderIndex: 0,
  processed: 0,
  success: 0,
  failed: 0,
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
      // Content script collected order IDs from list page
      handleOrderIdsCollected(message.orderIds);
      sendResponse({ success: true });
      return false;

    case 'ORDER_DATA_EXTRACTED':
      // Content script extracted data from detail page
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
        // On order list page - collect order IDs
        collectOrderIds();
      } else if (state.phase === 'processing' && tab.url.includes('/order/detail')) {
        // On order detail page - extract data
        if (!state.isProcessingOrder) {
          processCurrentOrder();
        }
      }
    }, 2000);
  }
});

/**
 * Handle start command
 */
async function handleStart(message) {
  if (state.isRunning) {
    return { error: 'Already running' };
  }

  // Reset state
  state = {
    isRunning: true,
    shouldStop: false,
    currentTabId: null,
    maxOrders: message.maxOrders || 100,
    delayMs: message.delayMs || 2000,
    orderIds: [],
    collectedData: [],
    currentOrderIndex: 0,
    processed: 0,
    success: 0,
    failed: 0,
    totalAmount: 0,
    isProcessingOrder: false,
    phase: 'collecting'
  };

  broadcastStatus('Opening TikTok Seller Center...');
  log('Starting export process...');

  try {
    // Open TikTok Seller Center shipped tab
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
 * Handle stop command
 */
function handleStop() {
  state.shouldStop = true;
  state.isRunning = false;
  state.phase = 'idle';

  broadcastStatus('Export stopped', false, true);
  log('Export stopped by user');
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
function handleOrderIdsCollected(orderIds) {
  if (!state.isRunning || state.shouldStop) return;

  state.orderIds = orderIds;
  log(`Collected ${orderIds.length} order IDs`);

  if (orderIds.length === 0) {
    log('No orders found!', 'error');
    state.isRunning = false;
    state.phase = 'done';
    broadcastStatus('No orders found', false, false, true);
    return;
  }

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

  if (state.currentOrderIndex >= state.orderIds.length) {
    // All done!
    state.isRunning = false;
    state.phase = 'done';
    log(`Export completed! ${state.success} success, ${state.failed} failed`);
    broadcastStatus('Export completed!', false, false, true);
    return;
  }

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);

  log(`Processing order ...${orderIdShort} (${state.currentOrderIndex + 1}/${state.orderIds.length})`);
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
    // Wait for page to render
    await sleep(1500);

    // Tell content script to extract data
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
function handleOrderDataExtracted(data) {
  if (!state.isRunning) return;

  const orderId = state.orderIds[state.currentOrderIndex];
  const orderIdShort = orderId.slice(-8);

  if (data && data.hasData && !data.isMasked) {
    // Success!
    state.success++;
    state.collectedData.push({
      order_id: orderId,
      customer_name: data.name || '',
      phone_number: data.phone_number || '',
      full_address: data.full_address || '',
      order_status: data.status || '',
      total_amount: data.total_amount || 0,
      currency: data.currency || 'MYR',
      order_date: data.order_date || '',
      extracted_at: new Date().toISOString()
    });

    state.totalAmount += parseFloat(data.total_amount || 0);
    log(`✓ Order ...${orderIdShort}: ${data.name}`, 'success');
  } else {
    state.failed++;
    log(`✗ Order ...${orderIdShort}: ${data.error || 'Data masked/unavailable'}`, 'error');
  }

  state.processed++;
  state.currentOrderIndex++;
  state.isProcessingOrder = false;

  broadcastStatus();

  // Continue to next order after delay
  setTimeout(() => processNextOrder(), state.delayMs);
}

/**
 * Handle order failure
 */
function handleOrderFailed(orderId, reason) {
  const orderIdShort = orderId.slice(-8);
  state.failed++;
  state.processed++;
  state.currentOrderIndex++;
  state.isProcessingOrder = false;

  log(`✗ Order ...${orderIdShort}: ${reason}`, 'error');
  broadcastStatus();

  // Continue to next order
  setTimeout(() => processNextOrder(), 1000);
}

/**
 * Download collected data as Excel/CSV
 */
async function downloadExcel() {
  if (state.collectedData.length === 0) {
    return { error: 'No data to download' };
  }

  try {
    // Create CSV content
    const headers = [
      'Order ID',
      'Customer Name',
      'Phone Number',
      'Full Address',
      'Order Status',
      'Total Amount',
      'Currency',
      'Order Date',
      'Extracted At'
    ];

    const rows = state.collectedData.map(row => [
      row.order_id,
      `"${(row.customer_name || '').replace(/"/g, '""')}"`,
      row.phone_number,
      `"${(row.full_address || '').replace(/"/g, '""')}"`,
      row.order_status,
      row.total_amount,
      row.currency,
      row.order_date,
      row.extracted_at
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    // Add BOM for Excel UTF-8 compatibility
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8' });

    // Create download URL
    const url = URL.createObjectURL(blob);
    const filename = `tiktok_orders_${new Date().toISOString().split('T')[0]}_${state.collectedData.length}orders.csv`;

    // Download file
    await chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    });

    log(`Downloaded ${filename}`);
    return { success: true, filename };
  } catch (error) {
    log('Download error: ' + error.message, 'error');
    return { error: error.message };
  }
}

/**
 * Get current status
 */
function getStatus() {
  return {
    isRunning: state.isRunning,
    phase: state.phase,
    total: state.orderIds.length,
    processed: state.processed,
    collected: state.collectedData.length,
    success: state.success,
    failed: state.failed,
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
console.log('[TikTok Order Exporter] Background service worker started');
