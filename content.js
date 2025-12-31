/**
 * Content Script for TikTok Order Exporter
 *
 * Handles:
 * - Collecting order IDs from the shipped orders list
 * - Clicking reveal icons on order detail pages
 * - Extracting customer data
 */

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Content] Message:', message.type);

  switch (message.type) {
    case 'COLLECT_ORDER_IDS':
      collectOrderIds(message.maxOrders).then(orderIds => {
        chrome.runtime.sendMessage({
          type: 'ORDER_IDS_COLLECTED',
          orderIds
        });
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

/**
 * Collect order IDs from the shipped orders list page
 * With pagination - 20 orders per page, clicks through pages
 */
async function collectOrderIds(maxOrders = 100) {
  console.log('[Content] Collecting order IDs, max:', maxOrders);

  const orderIds = [];
  const orderPattern = /5\d{16,18}/g;

  // Wait for page to load
  await sleep(2000);

  // Calculate pages needed (20 orders per page)
  const pagesNeeded = Math.ceil(maxOrders / 20);
  console.log('[Content] Need', pagesNeeded, 'pages for', maxOrders, 'orders');

  // Collect from page 1
  collectOrdersFromPage(orderIds, orderPattern, maxOrders);
  console.log('[Content] Page 1:', orderIds.length, 'orders');

  // Go through more pages if needed
  for (let page = 2; page <= pagesNeeded && orderIds.length < maxOrders; page++) {
    // Click the page number
    const clicked = clickPage(page);
    if (!clicked) {
      console.log('[Content] Could not click page', page);
      break;
    }

    // Wait for page to load
    await sleep(2500);

    // Collect orders from this page
    const before = orderIds.length;
    collectOrdersFromPage(orderIds, orderPattern, maxOrders);
    console.log('[Content] Page', page, ':', orderIds.length - before, 'new orders, total:', orderIds.length);

    // Stop if no new orders found
    if (orderIds.length === before) {
      console.log('[Content] No new orders on page', page);
      break;
    }
  }

  console.log('[Content] Total collected:', orderIds.length, 'order IDs');
  return orderIds;
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
 */
function clickPage(pageNum) {
  // Find pagination items with class "core-pagination-item"
  const paginationItems = document.querySelectorAll('.core-pagination-item');

  for (const item of paginationItems) {
    const text = item.textContent?.trim();
    if (text === String(pageNum)) {
      console.log('[Content] Clicking page', pageNum);
      item.click();
      return true;
    }
  }

  // Fallback: try aria-label
  const pageByLabel = document.querySelector(`[aria-label="Page ${pageNum}"]`);
  if (pageByLabel) {
    console.log('[Content] Clicking page', pageNum, 'via aria-label');
    pageByLabel.click();
    return true;
  }

  return false;
}


/**
 * Extract order data from detail page
 */
async function extractOrderData(orderId) {
  console.log('[Content] Extracting data for order:', orderId);

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

  console.log('[Content] Extracted data:', {
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
 * Click reveal buttons (eye icons)
 */
async function clickRevealButtons() {
  console.log('[Content] Clicking reveal buttons...');
  let clickedCount = 0;

  // Scroll to shipping address section first
  await scrollToShippingAddress();
  await sleep(500);

  // Method 1: SVGs with data-log_click_for="open_phone_plaintext"
  const revealIcons = document.querySelectorAll('svg[data-log_click_for="open_phone_plaintext"]');
  for (const icon of revealIcons) {
    if (simulateClick(icon)) {
      clickedCount++;
      await sleep(500);
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
          }
        }
      }
    }
  }

  console.log('[Content] Clicked', clickedCount, 'reveal buttons');
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
          console.log('[Content] Found Total amount:', result.amount);
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
        console.log('[Content] Found Total from line:', result.amount);
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
          console.log('[Content] Found Time created:', dateMatch[1]);
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

  console.log('[Content] Extracted items:', uniqueItems);
  console.log('[Content] Extracted SKUs:', uniqueSkus);

  return {
    items: uniqueItems.slice(0, 3).join(' | '),
    skuId: uniqueSkus.slice(0, 3).join(', ')
  };
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Log content script loaded
console.log('[TikTok Order Exporter] Content script loaded on:', window.location.href);
