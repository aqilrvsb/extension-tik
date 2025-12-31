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
 */
async function collectOrderIds(maxOrders = 100) {
  console.log('[Content] Collecting order IDs, max:', maxOrders);

  const orderIds = [];

  // Wait for page to load
  await sleep(2000);

  // Method 1: Find order links/rows in the table
  // TikTok order IDs are typically 18-digit numbers
  const orderPattern = /\d{17,19}/g;

  // Look for order IDs in the page
  // They appear in order links, order number displays, etc.
  const orderLinks = document.querySelectorAll('a[href*="order/detail"], a[href*="order_no="]');

  for (const link of orderLinks) {
    const href = link.href || '';
    const matches = href.match(orderPattern);
    if (matches) {
      for (const match of matches) {
        if (!orderIds.includes(match) && match.length >= 17) {
          orderIds.push(match);
          if (orderIds.length >= maxOrders) break;
        }
      }
    }
    if (orderIds.length >= maxOrders) break;
  }

  // Method 2: Look for order IDs in table cells
  if (orderIds.length < maxOrders) {
    const cells = document.querySelectorAll('td, div[class*="order"], span[class*="order"]');
    for (const cell of cells) {
      const text = cell.textContent || '';
      const matches = text.match(orderPattern);
      if (matches) {
        for (const match of matches) {
          if (!orderIds.includes(match) && match.length >= 17 && match.length <= 19) {
            orderIds.push(match);
            if (orderIds.length >= maxOrders) break;
          }
        }
      }
      if (orderIds.length >= maxOrders) break;
    }
  }

  // Method 3: Look in checkbox values or data attributes
  if (orderIds.length < maxOrders) {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const checkbox of checkboxes) {
      const value = checkbox.value || checkbox.dataset.orderId || '';
      const matches = value.match(orderPattern);
      if (matches) {
        for (const match of matches) {
          if (!orderIds.includes(match) && match.length >= 17) {
            orderIds.push(match);
            if (orderIds.length >= maxOrders) break;
          }
        }
      }
      if (orderIds.length >= maxOrders) break;
    }
  }

  console.log('[Content] Collected', orderIds.length, 'order IDs');
  return orderIds;
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
 * Extract total amount from page
 */
function extractTotalAmount() {
  const result = { amount: 0, currency: 'MYR' };

  // Look for price patterns like "RM 70.19" or "MYR 70.19"
  const pricePattern = /(RM|MYR)\s*([\d,]+\.?\d*)/gi;
  const pageText = document.body.innerText;

  // Find all prices and get the largest one (usually the total)
  let matches;
  const prices = [];
  while ((matches = pricePattern.exec(pageText)) !== null) {
    const amount = parseFloat(matches[2].replace(',', ''));
    if (!isNaN(amount)) {
      prices.push({ amount, currency: 'MYR' });
    }
  }

  // Look for "Total" label nearby
  const totalElements = document.querySelectorAll('*');
  for (const el of totalElements) {
    if (el.textContent?.toLowerCase().includes('total') && el.children.length === 0) {
      const parent = el.parentElement;
      if (parent) {
        const priceMatch = parent.textContent.match(/(RM|MYR)\s*([\d,]+\.?\d*)/i);
        if (priceMatch) {
          result.amount = parseFloat(priceMatch[2].replace(',', ''));
          return result;
        }
      }
    }
  }

  // Return the largest price found (likely the total)
  if (prices.length > 0) {
    prices.sort((a, b) => b.amount - a.amount);
    return prices[0];
  }

  return result;
}

/**
 * Extract order date from page
 */
function extractOrderDate() {
  // Look for date patterns
  const datePattern = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*(\d{1,2}:\d{2}(:\d{2})?)?/;

  // Look in common date locations
  const pageText = document.body.innerText;
  const match = pageText.match(datePattern);

  if (match) {
    return match[0];
  }

  // Look for "Today" or time patterns
  const timePattern = /Today\s+(\d{1,2}:\d{2}(:\d{2})?)/i;
  const timeMatch = pageText.match(timePattern);
  if (timeMatch) {
    const today = new Date().toLocaleDateString('en-GB');
    return `${today} ${timeMatch[1]}`;
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
 */
function extractItemsAndSku() {
  const items = [];
  const skuIds = [];

  // Look for SKU patterns - typically alphanumeric codes
  const pageText = document.body.innerText;

  // SKU pattern - look for SKU: or SKU ID: followed by alphanumeric
  const skuMatches = pageText.match(/SKU\s*(?:ID)?:?\s*([A-Za-z0-9\-_]+)/gi);
  if (skuMatches) {
    for (const match of skuMatches) {
      const skuValue = match.replace(/SKU\s*(?:ID)?:?\s*/i, '').trim();
      if (skuValue && !skuIds.includes(skuValue)) {
        skuIds.push(skuValue);
      }
    }
  }

  // Look for product names in the page
  // Products usually appear in a list with images and names

  // Method 1: Look for product name elements
  const productElements = document.querySelectorAll('[class*="product"], [class*="item"], [class*="sku"]');
  for (const el of productElements) {
    const text = el.textContent?.trim();
    // Filter for reasonable product name length
    if (text && text.length > 5 && text.length < 200 && !text.includes('RM')) {
      // Check if it looks like a product name (not too many numbers)
      const digitRatio = (text.match(/\d/g) || []).length / text.length;
      if (digitRatio < 0.3 && !items.includes(text)) {
        items.push(text);
      }
    }
  }

  // Method 2: Look in table rows or list items near product images
  const images = document.querySelectorAll('img[src*="product"], img[src*="item"], img[src*="p16"]');
  for (const img of images) {
    const parent = img.closest('div, tr, li');
    if (parent) {
      // Look for text that's not a price
      const allText = parent.innerText;
      const lines = allText.split('\n').filter(line => {
        const l = line.trim();
        return l.length > 3 && l.length < 200 && !l.includes('RM') && !l.match(/^\d+$/);
      });
      if (lines.length > 0 && !items.includes(lines[0])) {
        items.push(lines[0]);
      }

      // Also look for SKU in this context
      const skuMatch = allText.match(/SKU\s*(?:ID)?:?\s*([A-Za-z0-9\-_]+)/i);
      if (skuMatch && !skuIds.includes(skuMatch[1])) {
        skuIds.push(skuMatch[1]);
      }
    }
  }

  // Remove duplicates and join
  const uniqueItems = [...new Set(items)];
  const uniqueSkus = [...new Set(skuIds)];

  return {
    items: uniqueItems.slice(0, 5).join(' | '), // Limit to 5 items
    skuId: uniqueSkus.slice(0, 5).join(', ')    // Limit to 5 SKUs
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
