/**
 * Dashboard Script for TikTok Order Exporter
 * Displays exported orders in a DataTable with live refresh
 */

const DEBUG = false;
function debugLog(...args) {
  if (DEBUG) console.log('[Dashboard]', ...args);
}

let dataTable = null;
let autoRefreshInterval = null;
let orders = [];

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  loadOrders();
  loadExportHistory();
  initDarkMode();

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
  document.getElementById('refreshHistoryBtn').addEventListener('click', loadExportHistory);
  document.getElementById('darkModeToggle').addEventListener('click', toggleDarkMode);

  startAutoRefresh();
});

// Initialize dark mode from stored preference
function initDarkMode() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['darkMode'], function(result) {
        if (result.darkMode) {
          document.body.classList.add('dark-mode');
          document.getElementById('darkModeIcon').textContent = '☀️';
        }
      });
    } else {
      // Fallback to localStorage for non-extension contexts
      var isDark = localStorage.getItem('darkMode') === 'true';
      if (isDark) {
        document.body.classList.add('dark-mode');
        document.getElementById('darkModeIcon').textContent = '☀️';
      }
    }
  } catch (error) {
    debugLog('Error initializing dark mode:', error);
  }
}

// Toggle dark mode
function toggleDarkMode() {
  var body = document.body;
  var icon = document.getElementById('darkModeIcon');
  var isDark = body.classList.toggle('dark-mode');

  icon.textContent = isDark ? '☀️' : '🌙';

  // Save preference
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ darkMode: isDark });
    } else {
      localStorage.setItem('darkMode', isDark.toString());
    }
  } catch (error) {
    debugLog('Error saving dark mode preference:', error);
  }
}

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
  debugLog('Loading orders...');

  try {
    // Check if we're in a Chrome extension context
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      debugLog('Chrome storage available');

      // Use callback style for chrome.storage.local.get
      chrome.storage.local.get(['exportedOrders'], function(result) {
        debugLog('Raw storage result:', JSON.stringify(result));

        if (chrome.runtime.lastError) {
          console.error('[Dashboard] Storage error:', chrome.runtime.lastError.message);
          showError('Storage error: ' + chrome.runtime.lastError.message);
          return;
        }

        orders = result.exportedOrders || [];
        debugLog('Loaded', orders.length, 'orders');

        updateStats();
        renderTable();
        document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
      });
    } else {
      debugLog('Chrome storage NOT available');

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

  // Prepare table data - columns: Date, Order ID, Customer, Phone, Address, Items, Total, Payment
  var tableData = orders.map(function(order) {
    return [
      order.order_date || '-',                                    // Date Order (Time created)
      order.order_id || '-',                                       // Order ID
      order.customer_name || '-',                                  // Customer
      order.phone_number || '-',                                   // Phone
      order.full_address || '-',                                   // Address (full, will wrap)
      order.items || '-',                                          // Items (full, will wrap)
      'RM ' + parseFloat(order.total_amount || 0).toFixed(2),     // Total
      order.payment_method || '-'                                  // Payment
    ];
  });

  if (dataTable) {
    dataTable.clear();
    dataTable.rows.add(tableData);
    dataTable.draw();
  } else {
    dataTable = $('#ordersTable').DataTable({
      data: tableData,
      responsive: false,  // Disable responsive to show all columns
      scrollX: true,      // Enable horizontal scroll
      pageLength: 25,
      order: [[0, 'desc']],  // Sort by date descending
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
      columnDefs: [
        { targets: 0, width: '130px' },   // Date
        { targets: 1, width: '150px' },   // Order ID
        { targets: 2, width: '150px' },   // Customer
        { targets: 3, width: '120px' },   // Phone
        { targets: 4, width: '250px', className: 'wrap-text' },  // Address - wrap
        { targets: 5, width: '300px', className: 'wrap-text' },  // Items - wrap
        { targets: 6, width: '80px' },    // Total
        { targets: 7, width: '120px' }    // Payment
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
  debugLog('=== DEBUG STORAGE ===');

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
    debugLog('ALL storage items:', items);
    debugLog('Storage keys:', Object.keys(items));

    if (items.exportedOrders) {
      debugLog('exportedOrders count:', items.exportedOrders.length);
    } else {
      debugLog('exportedOrders is EMPTY or UNDEFINED');
    }

    // Show alert with summary
    var keys = Object.keys(items);
    var orderCount = items.exportedOrders ? items.exportedOrders.length : 0;
    alert('Storage Keys: ' + keys.join(', ') + '\n\nExported Orders: ' + orderCount + '\n\nCheck console (F12) for full data.');
  });
}

// Load export history
function loadExportHistory() {
  debugLog('Loading export history...');

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['exportHistory'], function(result) {
        if (chrome.runtime.lastError) {
          console.error('[Dashboard] Error loading history:', chrome.runtime.lastError.message);
          return;
        }

        var history = result.exportHistory || [];
        debugLog('Loaded', history.length, 'history entries');
        renderExportHistory(history);
      });
    }
  } catch (error) {
    console.error('[Dashboard] Error loading export history:', error);
  }
}

// Render export history table
function renderExportHistory(history) {
  var emptyHistoryState = document.getElementById('emptyHistoryState');
  var historyTable = document.getElementById('historyTable');
  var historyBody = document.getElementById('historyBody');

  if (!history || history.length === 0) {
    emptyHistoryState.style.display = 'block';
    historyTable.style.display = 'none';
    return;
  }

  emptyHistoryState.style.display = 'none';
  historyTable.style.display = 'table';

  // Build table rows
  var html = '';
  history.forEach(function(entry) {
    var date = new Date(entry.exportedAt);
    var formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    var formatBadge = entry.format === 'xlsx'
      ? '<span style="background: #28a745; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px;">XLSX</span>'
      : '<span style="background: #17a2b8; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px;">CSV</span>';

    html += '<tr>';
    html += '<td>' + formattedDate + '</td>';
    html += '<td>' + formatBadge + '</td>';
    html += '<td>' + entry.count + ' orders</td>';
    html += '<td style="font-size: 12px; color: #666;">' + (entry.filename || '-') + '</td>';
    html += '</tr>';
  });

  historyBody.innerHTML = html;
}

// Clear export history
function clearExportHistory() {
  if (!confirm('Are you sure you want to clear export history?')) {
    return;
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(['exportHistory'], function() {
        loadExportHistory();
        alert('Export history cleared!');
      });
    }
  } catch (error) {
    console.error('[Dashboard] Error clearing history:', error);
  }
}
