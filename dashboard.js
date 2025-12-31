/**
 * Dashboard Script for TikTok Order Exporter
 * Displays exported orders in a DataTable with live refresh
 */

let dataTable = null;
let autoRefreshInterval = null;
let orders = [];

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  loadOrders();

  // Auto-refresh toggle
  document.getElementById('autoRefresh').addEventListener('change', function() {
    if (this.checked) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  // Button event listeners (instead of inline onclick)
  document.getElementById('refreshBtn').addEventListener('click', refreshData);
  document.getElementById('clearBtn').addEventListener('click', clearAllData);
  document.getElementById('debugBtn').addEventListener('click', debugStorage);

  startAutoRefresh();
});

// Start auto-refresh
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshInterval = setInterval(loadOrders, 5000);
}

// Stop auto-refresh
function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

// Load orders from Chrome storage
function loadOrders() {
  console.log('[Dashboard] Loading orders...');

  try {
    // Check if we're in a Chrome extension context
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      console.log('[Dashboard] Chrome storage available');

      // Use callback style for chrome.storage.local.get
      chrome.storage.local.get(['exportedOrders'], function(result) {
        console.log('[Dashboard] Raw storage result:', JSON.stringify(result));

        if (chrome.runtime.lastError) {
          console.error('[Dashboard] Storage error:', chrome.runtime.lastError.message);
          showError('Storage error: ' + chrome.runtime.lastError.message);
          return;
        }

        orders = result.exportedOrders || [];
        console.log('[Dashboard] Loaded', orders.length, 'orders');
        console.log('[Dashboard] First order sample:', orders[0]);

        updateStats();
        renderTable();
        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
      });
    } else {
      console.log('[Dashboard] Chrome storage NOT available');
      console.log('[Dashboard] chrome:', typeof chrome);
      console.log('[Dashboard] chrome.storage:', typeof chrome !== 'undefined' ? chrome.storage : 'N/A');

      // Show error message
      showError('Chrome storage not available. Make sure you opened this page from the extension.');
    }

  } catch (error) {
    console.error('[Dashboard] Error loading orders:', error);
    showError('Error: ' + error.message);
  }
}

// Show error message
function showError(message) {
  var loadingState = document.getElementById('loadingState');
  loadingState.innerHTML = '<div style="color: #dc3545; font-size: 16px;">Warning: ' + message + '</div>' +
    '<div style="margin-top: 10px; font-size: 12px; color: #666;">Open DevTools (F12) - Console to see debug logs</div>';
}

// Refresh data manually
function refreshData() {
  loadOrders();
}

// Update stats
function updateStats() {
  document.getElementById('totalOrders').textContent = orders.length;

  var totalAmount = orders.reduce(function(sum, o) {
    return sum + parseFloat(o.total_amount || 0);
  }, 0);
  document.getElementById('totalAmount').textContent = 'RM ' + totalAmount.toFixed(2);

  var today = new Date().toDateString();
  var todayOrders = orders.filter(function(o) {
    var orderDate = new Date(o.extracted_at || o.order_date);
    return orderDate.toDateString() === today;
  }).length;
  document.getElementById('todayOrders').textContent = todayOrders;

  var phoneSet = {};
  orders.forEach(function(o) {
    var key = o.phone_number || o.customer_name;
    if (key) phoneSet[key] = true;
  });
  var uniqueCustomers = Object.keys(phoneSet).length;
  document.getElementById('uniqueCustomers').textContent = uniqueCustomers;
}

// Render DataTable
function renderTable() {
  var loadingState = document.getElementById('loadingState');
  var emptyState = document.getElementById('emptyState');
  var tableContainer = document.getElementById('tableContainer');

  loadingState.style.display = 'none';

  if (orders.length === 0) {
    emptyState.style.display = 'block';
    tableContainer.style.display = 'none';
    if (dataTable) {
      dataTable.destroy();
      dataTable = null;
    }
    return;
  }

  emptyState.style.display = 'none';
  tableContainer.style.display = 'block';

  // Prepare table data
  var tableData = orders.map(function(order) {
    var address = order.full_address || '-';
    var items = order.items || '-';
    return [
      order.order_id || '-',
      order.customer_name || '-',
      order.phone_number || '-',
      address.substring(0, 50) + (address.length > 50 ? '...' : ''),
      items.substring(0, 40) + (items.length > 40 ? '...' : ''),
      (order.currency || 'MYR') + ' ' + parseFloat(order.total_amount || 0).toFixed(2),
      order.shipping_method || '-',
      order.payment_method || '-',
      order.order_date || '-'
    ];
  });

  if (dataTable) {
    dataTable.clear();
    dataTable.rows.add(tableData);
    dataTable.draw();
  } else {
    dataTable = $('#ordersTable').DataTable({
      data: tableData,
      responsive: true,
      pageLength: 25,
      order: [[0, 'desc']],
      dom: 'Bfrtip',
      buttons: [
        {
          extend: 'csv',
          text: 'Export CSV',
          filename: 'tiktok_orders_' + new Date().toISOString().split('T')[0],
          exportOptions: {
            columns: ':visible'
          }
        },
        {
          extend: 'excel',
          text: 'Export Excel',
          filename: 'tiktok_orders_' + new Date().toISOString().split('T')[0],
          exportOptions: {
            columns: ':visible'
          }
        },
        {
          extend: 'print',
          text: 'Print',
          exportOptions: {
            columns: ':visible'
          }
        },
        {
          extend: 'copy',
          text: 'Copy'
        }
      ],
      language: {
        search: "Search:",
        lengthMenu: "Show _MENU_ orders",
        info: "Showing _START_ to _END_ of _TOTAL_ orders",
        infoEmpty: "No orders found",
        emptyTable: "No orders available"
      }
    });
  }
}

// Clear all data
function clearAllData() {
  if (!confirm('Are you sure you want to clear ALL exported orders? This cannot be undone.')) {
    return;
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(['exportedOrders', 'sessionState'], function() {
        orders = [];
        updateStats();
        renderTable();
        alert('All data cleared successfully!');
      });
    }
  } catch (error) {
    console.error('Error clearing data:', error);
    alert('Failed to clear data: ' + error.message);
  }
}

// Debug storage - show all keys and values
function debugStorage() {
  console.log('[Dashboard] === DEBUG STORAGE ===');

  if (typeof chrome === 'undefined') {
    alert('Chrome API not available');
    return;
  }

  if (!chrome.storage) {
    alert('chrome.storage not available');
    return;
  }

  if (!chrome.storage.local) {
    alert('chrome.storage.local not available');
    return;
  }

  // Get ALL storage data
  chrome.storage.local.get(null, function(items) {
    console.log('[Dashboard] ALL storage items:', items);
    console.log('[Dashboard] Storage keys:', Object.keys(items));

    if (items.exportedOrders) {
      console.log('[Dashboard] exportedOrders count:', items.exportedOrders.length);
      console.log('[Dashboard] exportedOrders data:', items.exportedOrders);
    } else {
      console.log('[Dashboard] exportedOrders is EMPTY or UNDEFINED');
    }

    // Show alert with summary
    var keys = Object.keys(items);
    var orderCount = items.exportedOrders ? items.exportedOrders.length : 0;
    alert('Storage Keys: ' + keys.join(', ') + '\n\nExported Orders: ' + orderCount + '\n\nCheck console (F12) for full data.');
  });
}
