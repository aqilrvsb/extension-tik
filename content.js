/**
 * Content Script for TikTok Order Exporter
 *
 * Handles:
 * - Collecting order IDs from the shipped orders list
 * - Clicking reveal icons on order detail pages
 * - Extracting customer data
 */

const DEBUG = false; // Set to true for verbose logging
function debugLog(...args) {
  if (DEBUG) console.log('[Content]', ...args);
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog('Message:', message.type);

  switch (message.type) {
    case 'COLLECT_ORDER_IDS':
      collectOrderIds(message.pageNumber || 1, message.dateFilter).then(orderIds => {
        // Only send if we actually collected (not skipped)
        if (orderIds !== null) {
          // Get the actual max pages from pagination AFTER filter is applied
          const actualMaxPages = getActualMaxPages();
          chrome.runtime.sendMessage({
            type: 'ORDER_IDS_COLLECTED',
            orderIds,
            pageNumber: message.pageNumber || 1,
            actualMaxPages: actualMaxPages // Send actual max pages to background
          });
        } else {
          debugLog('Collection was skipped, not sending result');
        }
      });
      sendResponse({ started: true });
      return false;

    case 'EXTRACT_ORDER_DATA':
      extractOrderData(message.orderId).then(data => {
        chrome.runtime.sendMessage({
          type: 'ORDER_DATA_EXTRACTED',
          data
        });
      });
      sendResponse({ started: true });
      return false;
  }
});

// Flag to prevent multiple simultaneous collections
let isCollecting = false;
let lastCollectionTime = 0;

/**
 * Get the actual maximum page number from pagination
 * Looks at the pagination buttons to find the highest page number
 * @returns {number} - The maximum page number available
 */
function getActualMaxPages() {
  let maxPage = 1;

  // Method 1: Find pagination items with aria-label="Page X"
  // TikTok uses: <li class="core-pagination-item" aria-label="Page 4">4</li>
  const paginationItems = document.querySelectorAll('[aria-label^="Page "]');
  for (const item of paginationItems) {
    const label = item.getAttribute('aria-label');
    const match = label?.match(/Page\s+(\d+)/);
    if (match) {
      const pageNum = parseInt(match[1]);
      if (pageNum > maxPage) maxPage = pageNum;
    }
  }

  // Method 2: Find core-pagination-item elements with numbers
  const coreItems = document.querySelectorAll('.core-pagination-item');
  for (const item of coreItems) {
    const text = item.textContent?.trim();
    const pageNum = parseInt(text);
    if (!isNaN(pageNum) && pageNum > maxPage) {
      maxPage = pageNum;
    }
  }

  // Method 3: Look for any pagination number buttons
  const paginationContainer = document.querySelector('.core-pagination, [class*="pagination"]');
  if (paginationContainer) {
    const buttons = paginationContainer.querySelectorAll('li, button, a, span');
    for (const btn of buttons) {
      const text = btn.textContent?.trim();
      const pageNum = parseInt(text);
      if (!isNaN(pageNum) && pageNum > maxPage && pageNum < 1000) {
        maxPage = pageNum;
      }
    }
  }

  debugLog(' Detected actual max pages:', maxPage);
  return maxPage;
}

/**
 * Get total order count from page (considers filters)
 * When date filter is active, looks for "Found X orders" first
 * Otherwise looks for Shipped tab count
 */
function getShippedCount() {
  // PRIORITY 1: "Found X orders" text - this shows FILTERED count
  // When filter is applied, TikTok shows "Found 36 orders" etc
  const foundText = document.body.innerText.match(/Found\s+([\d,]+)\s+orders/i);
  if (foundText) {
    const count = parseInt(foundText[1].replace(/,/g, ''));
    debugLog(' Found FILTERED count from "Found X orders":', count);
    return count;
  }

  // PRIORITY 2: Find the Shipped tab with adjacent count div (unfiltered total)
  // Structure: <div>Shipped</div><div style="margin-left: 2px;...">1,261</div>
  const shippedDivs = document.querySelectorAll('div');
  for (const div of shippedDivs) {
    if (div.textContent?.trim() === 'Shipped') {
      // Check next sibling for the count
      const nextDiv = div.nextElementSibling;
      if (nextDiv) {
        const countText = nextDiv.textContent?.trim();
        const count = parseInt(countText.replace(/,/g, ''));
        if (!isNaN(count) && count > 0) {
          debugLog(' Found shipped count from Shipped tab:', count);
          return count;
        }
      }
    }
  }

  // PRIORITY 3: Find by data attribute
  const shippedTab = document.querySelector('[data-log_click_for="shipped"]');
  if (shippedTab) {
    const countMatch = shippedTab.textContent?.match(/([\d,]+)/);
    if (countMatch) {
      const count = parseInt(countMatch[1].replace(/,/g, ''));
      debugLog(' Found shipped count from data attribute:', count);
      return count;
    }
  }

  // PRIORITY 4: Regex for "Shipped" followed by number
  const shippedMatch = document.body.innerText.match(/Shipped\s*([\d,]+)/i);
  if (shippedMatch) {
    const count = parseInt(shippedMatch[1].replace(/,/g, ''));
    debugLog(' Found shipped count from regex:', count);
    return count;
  }

  debugLog(' Could not find shipped count, defaulting to 10000');
  return 10000; // Default high number
}

/**
 * Collect order IDs from a SINGLE page of the shipped orders list
 * @param {number} pageNumber - The page number to collect from
 * @param {Object} dateFilter - Date filter { date: 'YYYY-MM-DD' } (single date)
 */
async function collectOrderIds(pageNumber = 1, dateFilter = null) {
  const now = Date.now();

  // Prevent multiple simultaneous calls (with 5 second cooldown)
  if (isCollecting) {
    debugLog(' Already collecting, skipping duplicate call');
    return null; // Return null to indicate skip, not empty array
  }

  // Prevent rapid re-calls within 5 seconds
  if (now - lastCollectionTime < 5000) {
    debugLog(' Called too recently, skipping');
    return null;
  }

  isCollecting = true;
  lastCollectionTime = now;

  debugLog(' ========================================');
  debugLog(' Collecting from page:', pageNumber);
  if (dateFilter && dateFilter.date) {
    debugLog(' Date filter:', dateFilter.date);
  }
  debugLog(' ========================================');

  const orderIds = [];
  const orderPattern = /5\d{16,18}/g;

  try {
    // Wait for page to fully load (increased to 10 seconds to prevent skipping)
    debugLog(' Waiting 10 seconds for page to fully load...');
    await sleep(10000);

    // Check if we're on the right page
    if (!window.location.href.includes('/order')) {
      debugLog(' Not on order page, skipping');
      return [];
    }

    // Apply date filter if provided (single date)
    if (dateFilter && dateFilter.date) {
      const filterApplied = await applySingleDateFilter(dateFilter.date);
      if (!filterApplied) {
        debugLog(' Warning: Date filter may not have been applied correctly');
      }
      // Wait longer for filtered results to load
      await sleep(3000);
    }

    // Scroll down to bottom slowly (human-like) to ensure all orders are loaded
    debugLog(' Scrolling down to load all orders...');
    await smoothScrollToBottom();
    await sleep(1500);

    // Scroll back to top
    window.scrollTo(0, 0);
    await sleep(1000);

    // If page > 1, navigate to that page first
    if (pageNumber > 1) {
      debugLog(' Navigating to page', pageNumber);
      const clicked = await clickPage(pageNumber);
      if (!clicked) {
        debugLog(' FAILED to click page', pageNumber);
        isCollecting = false;
        return [];
      }
      // Wait for page content to load
      await sleep(2500);
      window.scrollTo(0, 0);
      await sleep(500);
    }

    // Collect orders from current page only (max 20 per page on TikTok)
    collectOrdersFromPage(orderIds, orderPattern, 20);
    debugLog(' Page', pageNumber, 'collected:', orderIds.length, 'orders');

    // If no orders found, wait more and retry once
    if (orderIds.length === 0) {
      debugLog(' No orders found, waiting more...');
      await sleep(3000);
      collectOrdersFromPage(orderIds, orderPattern, 20);
      debugLog(' Retry:', orderIds.length, 'orders');
    }

    debugLog(' ========================================');
    debugLog(' Page', pageNumber, 'collected:', orderIds.length, 'order IDs');
    debugLog(' ========================================');

  } finally {
    isCollecting = false;
  }

  return orderIds;
}

/**
 * Apply single date filter (same date for start and end)
 */
async function applySingleDateFilter(dateStr) {
  debugLog(' Applying single date filter:', dateStr);

  // Use the same date for both start and end
  return await applyDateFilter({
    startDate: dateStr,
    endDate: dateStr
  });
}

/**
 * Collect orders from current page view
 */
function collectOrdersFromPage(orderIds, orderPattern, maxOrders) {
  // Find order links
  const orderLinks = document.querySelectorAll('a[href*="order/detail"], a[href*="order_no="]');
  for (const link of orderLinks) {
    if (orderIds.length >= maxOrders) return;
    const href = link.href || '';
    const matches = href.match(orderPattern);
    if (matches) {
      for (const match of matches) {
        if (!orderIds.includes(match)) {
          orderIds.push(match);
        }
      }
    }
  }
}

/**
 * Click a specific page number in pagination
 * Uses aria-label="Page X" which is the exact TikTok selector
 */
async function clickPage(pageNum) {
  debugLog(' Looking for page', pageNum, 'button...');

  // Scroll to make sure pagination is visible
  window.scrollTo(0, document.body.scrollHeight);
  await sleep(500);

  // Method 1: Use aria-label (EXACT match for TikTok)
  // TikTok uses: <li class="core-pagination-item" aria-label="Page 2">2</li>
  const pageByLabel = document.querySelector(`[aria-label="Page ${pageNum}"]`);
  if (pageByLabel) {
    debugLog(' Clicking page', pageNum, 'via aria-label="Page X"');
    pageByLabel.click();
    return true;
  }

  // Method 2: Click "Next" button (aria-label="Next")
  const nextBtn = document.querySelector('.core-pagination-item-next, [aria-label="Next"]');
  if (nextBtn && !nextBtn.classList.contains('core-pagination-item-disabled')) {
    debugLog(' Clicking NEXT button to go to page', pageNum);
    nextBtn.click();
    return true;
  }

  // Method 3: Find core-pagination-item with matching text
  const paginationItems = document.querySelectorAll('.core-pagination-item');
  for (const item of paginationItems) {
    const text = item.textContent?.trim();
    if (text === String(pageNum)) {
      debugLog(' Clicking page', pageNum, 'via core-pagination-item text');
      item.click();
      return true;
    }
  }

  debugLog(' Could not find page', pageNum, 'button');
  return false;
}

/**
 * Click the Shipped tab to ensure we're viewing shipped orders
 * Uses exact TikTok Seller Center selectors
 * @returns {boolean} - true if Shipped tab was clicked or already active
 */
async function clickShippedTab() {
  debugLog(' Clicking Shipped tab...');

  try {
    // Method 1: Use the exact data-log_click_for="shipped" attribute
    // Structure: <div data-log_click_for="shipped" data-log_module_name="order_list_tab">
    const shippedTab = document.querySelector('[data-log_click_for="shipped"]');
    if (shippedTab) {
      debugLog(' Found Shipped tab via data-log_click_for="shipped"');
      shippedTab.click();
      await sleep(1500); // Wait for tab to load
      return true;
    }

    // Method 2: Look for pulse-tabs-pane-title containing "Shipped"
    const tabTitles = document.querySelectorAll('.pulse-tabs-pane-title, .pulse-tabs-pane-title-content');
    for (const title of tabTitles) {
      if (title.textContent?.includes('Shipped')) {
        debugLog(' Found Shipped via pulse-tabs-pane-title');
        // Click the inner div with data-log_click_for or the title itself
        const clickTarget = title.querySelector('[data-log_click_for="shipped"]') || title;
        clickTarget.click();
        await sleep(1500);
        return true;
      }
    }

    // Method 3: Look for div with exact "Shipped" text followed by count
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      // Match div that contains exactly "Shipped" (not "Shipped to" etc)
      if (div.childNodes.length > 0) {
        const firstChild = div.childNodes[0];
        if (firstChild.nodeType === Node.ELEMENT_NODE || firstChild.nodeType === Node.TEXT_NODE) {
          const text = firstChild.textContent?.trim();
          if (text === 'Shipped') {
            // Check if this is part of the tab structure
            const parent = div.closest('.pulse-tabs-pane-title') ||
                          div.closest('[data-log_module_name="order_list_tab"]') ||
                          div.closest('[role="tab"]');
            if (parent) {
              debugLog(' Found Shipped tab via parent structure');
              parent.click();
              await sleep(1500);
              return true;
            }
            // Try clicking the div itself
            debugLog(' Clicking Shipped div directly');
            div.click();
            await sleep(1500);
            return true;
          }
        }
      }
    }

    // Method 4: Look for tab with "Shipped" text and a count number
    const tabs = document.querySelectorAll('[role="tab"], .arco-tabs-tab, [class*="tab"]');
    for (const tab of tabs) {
      if (tab.textContent?.includes('Shipped') && /\d+/.test(tab.textContent)) {
        debugLog(' Found Shipped tab via role="tab" with count');
        tab.click();
        await sleep(1500);
        return true;
      }
    }

    debugLog(' Shipped tab not found, may already be on shipped orders');
    return true; // Continue anyway

  } catch (error) {
    debugLog(' Error clicking Shipped tab:', error);
    return false;
  }
}

/**
 * Select "Time shipped" option from the filter dropdown
 * Uses exact TikTok Seller Center selectors
 * @returns {boolean} - true if Time shipped was selected
 */
async function selectTimeShippedFilter() {
  debugLog(' Selecting Time shipped filter...');

  try {
    // Method 1: Find the core-select-view containing "Time created" or "Time shipped"
    // TikTok uses: <div class="core-select-view">...<span class="core-select-view-value">Time created</span>
    const selectViews = document.querySelectorAll('.core-select-view');

    for (const selectView of selectViews) {
      const valueSpan = selectView.querySelector('.core-select-view-value');
      const text = valueSpan?.textContent?.trim() || '';

      if (text === 'Time created' || text === 'Time shipped') {
        debugLog(' Found time filter dropdown with value:', text);

        // If already "Time shipped", no need to change
        if (text === 'Time shipped') {
          debugLog(' Already set to Time shipped');
          return true;
        }

        // Click to open dropdown
        selectView.click();
        await sleep(600);

        // Find and click "Time shipped" option in the dropdown popup
        // Options usually appear in a portal/popup with class core-select-option
        const options = document.querySelectorAll('.core-select-option, [class*="select-option"], [role="option"]');
        for (const option of options) {
          if (option.textContent?.includes('Time shipped')) {
            debugLog(' Clicking Time shipped option');
            option.click();
            await sleep(500);
            return true;
          }
        }

        // Fallback: Search all visible elements for "Time shipped"
        const allVisible = document.querySelectorAll('div, span, li');
        for (const el of allVisible) {
          if (el.textContent?.trim() === 'Time shipped' && el.offsetParent !== null) {
            debugLog(' Found visible Time shipped element');
            el.click();
            await sleep(500);
            return true;
          }
        }
      }
    }

    // Method 2: Direct search for select with "Time created" in value
    const selects = document.querySelectorAll('[class*="select"]');
    for (const select of selects) {
      const text = select.textContent || '';
      if (text.includes('Time created') && !text.includes('Time shipped')) {
        debugLog(' Found select with Time created text');
        select.click();
        await sleep(600);

        // Wait for dropdown to appear and find Time shipped
        const options = document.querySelectorAll('[class*="option"]');
        for (const option of options) {
          if (option.textContent?.includes('Time shipped')) {
            debugLog(' Clicking Time shipped option from fallback');
            option.click();
            await sleep(500);
            return true;
          }
        }
      }
    }

    // Method 3: Look for line-clamp div with exact text
    const lineClampDivs = document.querySelectorAll('.line-clamp-2, [class*="line-clamp"]');
    for (const div of lineClampDivs) {
      if (div.textContent?.trim() === 'Time created') {
        debugLog(' Found line-clamp Time created, clicking parent');
        // Click the parent select-view
        const parent = div.closest('.core-select-view') || div.closest('[class*="select"]');
        if (parent) {
          parent.click();
          await sleep(600);

          // Find Time shipped option
          const options = document.querySelectorAll('[class*="option"]');
          for (const option of options) {
            if (option.textContent?.includes('Time shipped')) {
              debugLog(' Clicking Time shipped');
              option.click();
              await sleep(500);
              return true;
            }
          }
        }
      }
    }

    debugLog(' Time shipped option not found, filter may already be set or unavailable');
    return true; // Continue anyway

  } catch (error) {
    debugLog(' Error selecting Time shipped:', error);
    return false;
  }
}

/**
 * Apply date filter by clicking Filter button and setting date range
 * IMPORTANT: Uses "Time shipped" filter, NOT "Time created"
 * @param {Object} dateFilter - { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 * @returns {boolean} - true if filter was applied successfully
 */
async function applyDateFilter(dateFilter) {
  debugLog(' Applying date filter:', dateFilter.startDate, 'to', dateFilter.endDate);

  try {
    // STEP 0: First ensure we're on the Shipped tab
    await clickShippedTab();
    await sleep(1000);

    // Step 1: Click the Filter button
    const filterButton = document.querySelector('[data-log_click_for="filter_button"]');
    if (!filterButton) {
      debugLog(' Filter button not found');
      return false;
    }

    debugLog(' Clicking Filter button...');
    filterButton.click();
    await sleep(1000); // Wait for filter panel to open

    // STEP 1.5: Select "Time shipped" instead of "Time created"
    await selectTimeShippedFilter();
    await sleep(500);

    // Step 2: Find the date picker inputs
    // Look for the date range picker with placeholder "From" and "To"
    const datePickerContainer = document.querySelector('.core-picker-range, [data-tid="m4b_date_picker_range_picker"]');
    if (!datePickerContainer) {
      debugLog(' Date picker container not found');
      return false;
    }

    // Step 3: Click on the "From" input to open the date picker
    const fromInput = datePickerContainer.querySelector('input[placeholder="From"]');
    const toInput = datePickerContainer.querySelector('input[placeholder="To"]');

    if (!fromInput || !toInput) {
      debugLog(' Date inputs not found');
      return false;
    }

    // Step 4: Clear existing dates by clicking the clear button if visible
    const clearButton = datePickerContainer.querySelector('.core-picker-clear-icon');
    if (clearButton) {
      debugLog(' Clearing existing date filter...');
      clearButton.click();
      await sleep(500);
    }

    // Step 5: Click on the From input to focus it
    debugLog(' Clicking From input...');
    fromInput.click();
    await sleep(500);

    // Step 6: Set the start date
    // Format: DD/MM/YYYY (TikTok uses this format in MY region)
    const startDate = formatDateForInput(dateFilter.startDate);
    debugLog(' Setting start date:', startDate);

    // Try to set value directly and trigger events
    await setDateInputValue(fromInput, startDate);
    await sleep(500);

    // Step 7: Click on the To input
    debugLog(' Clicking To input...');
    toInput.click();
    await sleep(500);

    // Step 8: Set the end date
    const endDate = formatDateForInput(dateFilter.endDate);
    debugLog(' Setting end date:', endDate);

    await setDateInputValue(toInput, endDate);
    await sleep(500);

    // Step 9: Click outside to close picker (optional)
    document.body.click();
    await sleep(300);

    // Step 10: Find and click the Apply button
    const applyButton = document.querySelector('[data-log_click_for="apply"]');
    if (applyButton) {
      debugLog(' Clicking Apply button...');
      applyButton.click();
      await sleep(2000); // Wait for filter to be applied
      debugLog(' Date filter applied successfully');
      return true;
    } else {
      debugLog(' Apply button not found');
      return false;
    }

  } catch (error) {
    debugLog(' Error applying date filter:', error);
    return false;
  }
}

/**
 * Format date from YYYY-MM-DD to DD/MM/YYYY
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} - Date in DD/MM/YYYY format
 */
function formatDateForInput(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Set date input value using various methods
 * @param {HTMLInputElement} input - The input element
 * @param {string} value - The date value to set
 */
async function setDateInputValue(input, value) {
  // Method 1: Try direct value assignment with React synthetic event
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(input, value);

  // Dispatch input event
  const inputEvent = new Event('input', { bubbles: true });
  input.dispatchEvent(inputEvent);

  // Dispatch change event
  const changeEvent = new Event('change', { bubbles: true });
  input.dispatchEvent(changeEvent);

  // Also try keyboard events to simulate typing
  input.focus();
  await sleep(100);

  // Clear and type
  input.select();
  document.execCommand('insertText', false, value);

  await sleep(200);
}


/**
 * Extract order data from detail page
 */
async function extractOrderData(orderId) {
  debugLog(' Extracting data for order:', orderId);

  // First click reveal buttons
  await clickRevealButtons();

  // Wait for data to load
  await sleep(2000);

  // Extract data
  const data = {
    order_id: orderId,
    name: null,
    phone_number: null,
    full_address: null,
    status: null,
    total_amount: null,
    currency: 'MYR',
    order_date: null,       // Time created
    shipping_method: null,
    payment_method: null,
    items: null,
    sku_id: null,
    hasData: false,
    isMasked: true,
    error: null
  };

  try {
    // Find shipping address section
    const shippingContainer = findShippingAddressSection();

    if (shippingContainer) {
      // Extract texts from shipping section
      const texts = extractTextsFromContainer(shippingContainer);

      for (const text of texts) {
        // Skip masked text
        if (text.includes('***') || text.includes('****')) {
          continue;
        }

        // Phone number detection
        if (!data.phone_number) {
          const phoneMatch = text.match(/\+?60\d{8,11}|\(\+60\)\d{8,11}|01\d{8,9}/);
          if (phoneMatch) {
            data.phone_number = phoneMatch[0];
            continue;
          }
        }

        // Address detection
        if (!data.full_address && (
          text.includes('Malaysia') ||
          /\d{5}/.test(text) ||
          text.length > 35 ||
          /jalan|lorong|taman|kampung|blok|unit|no\.|tingkat|bandar/i.test(text)
        )) {
          data.full_address = text;
          continue;
        }

        // Name detection
        if (!data.name && text.length >= 2 && text.length < 50) {
          const letterCount = (text.match(/[a-zA-Z\s]/g) || []).length;
          const digitCount = (text.match(/\d/g) || []).length;
          if (letterCount > text.length * 0.6 && digitCount < 3) {
            data.name = text;
            continue;
          }
        }
      }
    }

    // Extract order status
    data.status = extractOrderStatus();

    // Extract total amount
    const amountInfo = extractTotalAmount();
    data.total_amount = amountInfo.amount;
    data.currency = amountInfo.currency;

    // Extract order date
    data.order_date = extractOrderDate();

    // Extract shipping method
    data.shipping_method = extractShippingMethod();

    // Extract payment method
    data.payment_method = extractPaymentMethod();

    // Extract items and SKU
    const itemsData = extractItemsAndSku();
    data.items = itemsData.items;
    data.sku_id = itemsData.skuId;

    // Check if data is valid
    data.hasData = !!(data.name || data.phone_number || data.full_address);
    data.isMasked = !data.hasData ||
      (data.name && data.name.includes('*')) ||
      (data.phone_number && data.phone_number.includes('*')) ||
      (data.full_address && data.full_address.includes('*'));

  } catch (error) {
    data.error = error.message;
  }

  debugLog(' Extracted data:', {
    hasData: data.hasData,
    isMasked: data.isMasked,
    name: data.name,
    phone: data.phone_number
  });

  return data;
}

/**
 * Find the shipping address section
 */
function findShippingAddressSection() {
  const allDivs = document.querySelectorAll('div');

  for (const div of allDivs) {
    if (div.textContent?.trim() === 'Shipping address' && div.children.length === 0) {
      return div.parentElement;
    }
  }

  return null;
}

/**
 * Extract texts from a container
 */
function extractTextsFromContainer(container) {
  const texts = [];
  const allDivs = container.querySelectorAll('div');

  for (const div of allDivs) {
    if (div.children.length === 0 || div.querySelector('svg')) {
      let text = '';
      for (const node of div.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        }
      }
      text = text.trim();

      if (text && text.length > 1 && text !== 'Shipping address') {
        texts.push(text);
      }
    }
  }

  return texts;
}

/**
 * Dismiss privacy protection modal if it appears
 * This modal shows "To better protect our customers' privacy..."
 *
 * IMPORTANT: Do NOT click "Cancel" - it re-masks the data!
 * Instead, click the backdrop/overlay or press Escape to dismiss without cancelling
 */
async function dismissPrivacyModal() {
  // Check if privacy modal is present
  const modalText = document.body.innerText;
  const hasPrivacyModal = modalText.includes('better protect our customers') ||
                          modalText.includes('privacy and create a healthy') ||
                          modalText.includes('Create ticket');

  if (!hasPrivacyModal) {
    return false;
  }

  debugLog(' Privacy modal detected, dismissing without Cancel...');

  // Method 1: Press Escape key to close modal (keeps data unmasked)
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true
  }));
  await sleep(300);

  // Method 2: Click the backdrop/overlay (the dark area behind modal)
  const overlays = document.querySelectorAll('[class*="overlay"], [class*="mask"], [class*="backdrop"]');
  for (const overlay of overlays) {
    const style = window.getComputedStyle(overlay);
    if (style.position === 'fixed' && style.zIndex) {
      debugLog(' Clicking overlay backdrop...');
      overlay.click();
      await sleep(300);
      break;
    }
  }

  // Method 3: Click outside modal area (top-left corner)
  document.body.click();
  await sleep(200);

  // Method 4: Find and click close button (X icon) if exists
  const closeButtons = document.querySelectorAll('[class*="close"], [aria-label="Close"], [aria-label="close"]');
  for (const btn of closeButtons) {
    if (btn.closest('[class*="modal"], [class*="dialog"], [role="dialog"]')) {
      debugLog(' Clicking close X button...');
      btn.click();
      await sleep(300);
      return true;
    }
  }

  return true;
}

/**
 * Click reveal buttons (eye icons)
 */
async function clickRevealButtons() {
  debugLog(' Clicking reveal buttons...');
  let clickedCount = 0;

  // Scroll to shipping address section first
  await scrollToShippingAddress();
  await sleep(500);

  // First, dismiss any existing privacy modal
  await dismissPrivacyModal();

  // Method 1: SVGs with data-log_click_for="open_phone_plaintext"
  const revealIcons = document.querySelectorAll('svg[data-log_click_for="open_phone_plaintext"]');
  for (const icon of revealIcons) {
    if (simulateClick(icon)) {
      clickedCount++;
      await sleep(500);
      // Check and dismiss privacy modal if it appeared
      await dismissPrivacyModal();
    }
  }

  // Method 2: Eye invisible icons
  const eyeIcons = document.querySelectorAll('svg.arco-icon-eye_invisible, svg[class*="eye_invisible"]');
  for (const icon of eyeIcons) {
    if (icon.dataset.clicked === 'true') continue;
    if (simulateClick(icon)) {
      icon.dataset.clicked = 'true';
      clickedCount++;
      await sleep(500);
      // Check and dismiss privacy modal if it appeared
      await dismissPrivacyModal();
    }
  }

  // Method 3: Cursor pointer elements near masked text
  const maskedTexts = document.querySelectorAll('div');
  for (const div of maskedTexts) {
    const text = div.textContent || '';
    if ((text.includes('***') || text.includes('****')) && text.length < 80) {
      const parent = div.parentElement;
      if (parent) {
        const nearbySpan = parent.querySelector('span');
        if (nearbySpan) {
          const svg = nearbySpan.querySelector('svg');
          if (svg && svg.dataset.clicked !== 'true') {
            simulateClick(svg);
            simulateClick(nearbySpan);
            svg.dataset.clicked = 'true';
            clickedCount++;
            await sleep(500);
            // Check and dismiss privacy modal if it appeared
            await dismissPrivacyModal();
          }
        }
      }
    }
  }

  // Final check for any remaining modal
  await dismissPrivacyModal();

  debugLog(' Clicked', clickedCount, 'reveal buttons');
  return clickedCount;
}

/**
 * Scroll to shipping address section
 */
async function scrollToShippingAddress() {
  window.scrollTo(0, 500);
  await sleep(300);

  const allDivs = document.querySelectorAll('div');
  for (const div of allDivs) {
    if (div.textContent?.trim() === 'Shipping address' && div.children.length === 0) {
      div.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(500);
      return;
    }
  }

  window.scrollTo(0, 800);
}

/**
 * Simulate mouse click
 */
function simulateClick(element) {
  if (!element) return false;

  try {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    ['mousedown', 'mouseup', 'click'].forEach(eventType => {
      element.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y
      }));
    });

    element.click();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extract order status from page
 */
function extractOrderStatus() {
  // Look for status badges/labels
  const statusPatterns = ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'SHIPPED'];

  // Check for status text in common locations
  const statusElements = document.querySelectorAll('[class*="status"], [class*="badge"], [class*="tag"]');
  for (const el of statusElements) {
    const text = el.textContent?.toUpperCase().replace(/[\s-]/g, '_') || '';
    for (const pattern of statusPatterns) {
      if (text.includes(pattern) || text.includes(pattern.replace('_', ' '))) {
        return pattern;
      }
    }
  }

  // Check page text
  const pageText = document.body.innerText.toUpperCase();
  if (pageText.includes('IN TRANSIT')) return 'IN_TRANSIT';
  if (pageText.includes('AWAITING COLLECTION')) return 'AWAITING_COLLECTION';
  if (pageText.includes('DELIVERED')) return 'DELIVERED';
  if (pageText.includes('COMPLETED')) return 'COMPLETED';

  return 'SHIPPED';
}

/**
 * Extract total amount from page - looks for "Total" row with RM amount
 */
function extractTotalAmount() {
  const result = { amount: 0, currency: 'MYR' };

  // Method 1: Look for the specific "Total" label in the right sidebar
  const allDivs = document.querySelectorAll('div');
  for (const div of allDivs) {
    const text = div.textContent?.trim();
    // Look for div that contains exactly "Total" as a label
    if (text === 'Total' && div.children.length === 0) {
      // Look in parent or sibling for the price
      const parent = div.parentElement;
      if (parent) {
        const priceMatch = parent.textContent.match(/RM\s*([\d,]+\.?\d*)/i);
        if (priceMatch) {
          result.amount = parseFloat(priceMatch[1].replace(',', ''));
          debugLog(' Found Total amount:', result.amount);
          return result;
        }
      }
    }
  }

  // Method 2: Look for row with "Total" and price on same line
  const pageText = document.body.innerText;
  const lines = pageText.split('\n');
  for (const line of lines) {
    if (line.includes('Total') && !line.includes('subtotal') && !line.includes('Subtotal')) {
      const priceMatch = line.match(/RM\s*([\d,]+\.?\d*)/i);
      if (priceMatch) {
        result.amount = parseFloat(priceMatch[1].replace(',', ''));
        debugLog(' Found Total from line:', result.amount);
        return result;
      }
    }
  }

  // Method 3: Find the price next to "Total" text
  const totalPattern = /Total\s*RM\s*([\d,]+\.?\d*)/i;
  const match = pageText.match(totalPattern);
  if (match) {
    result.amount = parseFloat(match[1].replace(',', ''));
    return result;
  }

  return result;
}

/**
 * Extract order date from page - looks for "Time created" field
 */
function extractOrderDate() {
  // Method 1: Look for "Time created" label specifically
  const allDivs = document.querySelectorAll('div');
  for (const div of allDivs) {
    const text = div.textContent?.trim();
    if (text === 'Time created' && div.children.length === 0) {
      // Look in parent for the date value
      const parent = div.parentElement;
      if (parent) {
        // Look for date pattern in siblings
        const fullText = parent.textContent;
        const dateMatch = fullText.match(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2})/);
        if (dateMatch) {
          debugLog(' Found Time created:', dateMatch[1]);
          return dateMatch[1];
        }
      }
    }
  }

  // Method 2: Look for date patterns with time
  const pageText = document.body.innerText;
  const datePattern = /(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2})/;
  const match = pageText.match(datePattern);
  if (match) {
    return match[1];
  }

  // Method 3: Simple date pattern
  const simpleDatePattern = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*(\d{1,2}:\d{2}(:\d{2})?)?/;
  const simpleMatch = pageText.match(simpleDatePattern);
  if (simpleMatch) {
    return simpleMatch[0];
  }

  return new Date().toISOString().split('T')[0];
}

/**
 * Extract shipping method from page
 */
function extractShippingMethod() {
  // Common shipping methods
  const shippingMethods = [
    'J&T Express',
    'J&T',
    'Shopee Express',
    'DHL',
    'Ninja Van',
    'PosLaju',
    'FedEx',
    'Flash Express',
    'Standard shipping',
    'Economy shipping',
    'Express shipping',
    'Shipped via platform'
  ];

  const pageText = document.body.innerText;

  // Look for shipping method mentions
  for (const method of shippingMethods) {
    if (pageText.toLowerCase().includes(method.toLowerCase())) {
      // Try to find the full text with tracking number
      const regex = new RegExp(`${method}[^\\n]*`, 'i');
      const match = pageText.match(regex);
      if (match) {
        return match[0].trim().substring(0, 100); // Limit length
      }
      return method;
    }
  }

  // Look for "Shipping method" label
  const shippingLabels = document.querySelectorAll('*');
  for (const el of shippingLabels) {
    if (el.textContent?.toLowerCase().includes('shipping method') && el.children.length === 0) {
      const parent = el.parentElement;
      if (parent) {
        const siblingText = parent.textContent?.replace('Shipping method', '').trim();
        if (siblingText && siblingText.length < 100) {
          return siblingText;
        }
      }
    }
  }

  return '';
}

/**
 * Extract payment method from page
 */
function extractPaymentMethod() {
  const paymentMethods = [
    'SPayLater',
    'Spaylater',
    'TikTok Wallet',
    'Credit Card',
    'Debit Card',
    'Bank Transfer',
    'Cash on Delivery',
    'COD',
    'Online Banking',
    'E-Wallet',
    'GrabPay',
    'Touch n Go',
    'Boost',
    'ShopeePay'
  ];

  const pageText = document.body.innerText;

  // Look for payment method mentions
  for (const method of paymentMethods) {
    if (pageText.toLowerCase().includes(method.toLowerCase())) {
      return method;
    }
  }

  // Look for "Payment method" label
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const text = el.textContent?.toLowerCase() || '';
    if ((text.includes('payment method') || text.includes('payment:')) && el.children.length === 0) {
      const parent = el.parentElement;
      if (parent) {
        const fullText = parent.textContent || '';
        // Extract the value after the label
        const match = fullText.match(/payment\s*(method)?:?\s*(.+)/i);
        if (match && match[2]) {
          return match[2].trim().substring(0, 50);
        }
      }
    }
  }

  return '';
}

/**
 * Extract items/products and SKU IDs from page
 * Gets product name + variant (e.g., "Product Name\n4 Botol + FREE 1 Botol")
 */
function extractItemsAndSku() {
  const items = [];
  const skuIds = [];

  // Look for SKU ID - the long numeric code
  const pageText = document.body.innerText;
  const skuIdMatch = pageText.match(/SKU\s*ID:?\s*(\d{15,20})/i);
  if (skuIdMatch) {
    skuIds.push(skuIdMatch[1]);
  }

  // Method 1: Find product in the parcel section
  // Look for elements near product images
  const productImages = document.querySelectorAll('img[src*="p16-oec"], img[src*="product"]');

  for (const img of productImages) {
    // Get the container that holds the product info
    let container = img.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      container = container.parentElement;
    }

    if (container) {
      const containerText = container.innerText;
      const lines = containerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      // Find product name - usually a long descriptive text
      for (const line of lines) {
        // Skip short lines, prices, dates, and SKU labels
        if (line.length < 10) continue;
        if (line.match(/^RM\s*[\d.]+/)) continue;
        if (line.match(/^SKU\s*ID/i)) continue;
        if (line.match(/^\d{1,2}\/\d{1,2}\/\d{4}/)) continue;
        if (line.match(/x\s*\d+$/)) continue;  // Skip "x 1" quantity
        if (line.includes('parcel') && line.includes('item')) continue;

        // This looks like a product name
        if (line.length > 15 && !items.includes(line)) {
          items.push(line);
          break;
        }
      }

      // Find variant/option (e.g., "4 Botol + FREE 1 Botol")
      for (const line of lines) {
        if (line.length >= 5 && line.length < 50) {
          // Check if it looks like a variant (contains numbers or size descriptors)
          if (line.match(/\d+\s*(botol|pcs|unit|pack|box|ml|g|kg)/i) ||
              line.match(/FREE|BONUS/i) ||
              line.match(/^\d+\s+[A-Za-z]/)) {
            // Add as variant to the last item
            if (items.length > 0 && !items[items.length - 1].includes(line)) {
              items[items.length - 1] += '\n' + line;
            }
            break;
          }
        }
      }
    }
  }

  // Method 2: Look for product name near "SKU ID:" label
  if (items.length === 0) {
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const text = div.textContent?.trim();
      if (text && text.startsWith('SKU ID:')) {
        // Get parent and look for product name
        let parent = div.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
          const parentText = parent.innerText;
          const lines = parentText.split('\n').map(l => l.trim()).filter(l => l.length > 20);
          for (const line of lines) {
            if (!line.includes('SKU') && !line.match(/^RM/) && !items.includes(line)) {
              items.push(line);
              break;
            }
          }
          if (items.length > 0) break;
          parent = parent.parentElement;
        }
      }
    }
  }

  // Clean up items - remove duplicates and format nicely
  const uniqueItems = [...new Set(items)];
  const uniqueSkus = [...new Set(skuIds)];

  debugLog(' Extracted items:', uniqueItems);
  debugLog(' Extracted SKUs:', uniqueSkus);

  return {
    items: uniqueItems.slice(0, 3).join(' | '),
    skuId: uniqueSkus.slice(0, 3).join(', ')
  };
}

/**
 * Smooth scroll to bottom (human-like scrolling)
 * Scrolls in multiple steps instead of instant jump
 */
async function smoothScrollToBottom() {
  const scrollHeight = document.body.scrollHeight;
  const viewportHeight = window.innerHeight;
  const scrollSteps = 5; // Number of scroll steps
  const stepDelay = 300; // Delay between steps (ms)

  for (let i = 1; i <= scrollSteps; i++) {
    const targetY = Math.min((scrollHeight / scrollSteps) * i, scrollHeight - viewportHeight);
    window.scrollTo({
      top: targetY,
      behavior: 'smooth'
    });
    await sleep(stepDelay);
  }

  // Final scroll to absolute bottom
  window.scrollTo(0, document.body.scrollHeight);
  await sleep(500);
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Log content script loaded (only in debug mode)
if (DEBUG) console.log('[TikTok Order Exporter] Content script loaded on:', window.location.href);
