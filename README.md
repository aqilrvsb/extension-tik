# TikTok Order Exporter

A standalone Chrome extension to export TikTok Shop shipped orders with customer details to Excel/CSV.

## Features

- Automatically navigates through shipped orders
- Clicks reveal buttons to unmask customer data
- Extracts: Order ID, Customer Name, Phone, Address, Status, Amount, Date
- Exports all data to CSV/Excel file
- Works completely offline - no external services needed
- Configurable: Set max orders and delay between requests

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this folder (`extension-tik`)
5. The extension icon will appear in your toolbar

### Generate Icons

Before loading the extension, you need to generate the icons:

1. Open `icons/generate-icons.html` in your browser
2. Click each "Download" link to save the icons
3. Save them to the `icons/` folder as:
   - `icon16.png`
   - `icon48.png`
   - `icon128.png`

## How to Use

1. **Log into TikTok Seller Center** in Chrome
   - Go to https://seller-my.tiktok.com
   - Make sure you're logged in

2. **Click the extension icon** in the toolbar

3. **Configure settings** (optional):
   - Max orders to process (default: 100)
   - Delay between orders in ms (default: 2000)

4. **Click "Start Export"**

5. The extension will:
   - Open TikTok Seller Center → Shipped tab
   - Collect order IDs from the list
   - Navigate to each order detail page
   - Click reveal buttons to unmask data
   - Extract customer information
   - Store all data in memory

6. When done, **click "Download Excel"** to save the CSV file

## Output Format

The exported CSV contains:

| Column | Description |
|--------|-------------|
| Order ID | TikTok order number |
| Customer Name | Unmasked customer name |
| Phone Number | Customer phone (+60...) |
| Full Address | Complete delivery address |
| Order Status | AWAITING_COLLECTION, IN_TRANSIT, etc. |
| Total Amount | Order total |
| Currency | MYR |
| Order Date | When order was placed |
| Extracted At | When data was extracted |

## Files

```
extension-tik/
├── manifest.json     # Extension configuration
├── popup.html        # Extension popup UI
├── popup.js          # Popup logic
├── background.js     # Order processing logic
├── content.js        # Page data extraction
├── icons/            # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── generate-icons.html
└── README.md
```

## Troubleshooting

### Extension not collecting orders?
- Make sure you're logged into TikTok Seller Center
- Refresh the page and try again
- Check that you have shipped orders

### Data still masked?
- TikTok may require additional verification
- Try manually clicking reveal on one order first
- The extension will skip masked orders

### CSV file not opening correctly in Excel?
- The file uses UTF-8 encoding with BOM
- If characters look wrong, try opening with Google Sheets

## Privacy

- All data is processed locally in your browser
- No data is sent to any external server
- CSV files are saved directly to your computer

## Development

To modify the extension:
1. Edit the files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Test your changes

## License

MIT License - Free to use and modify
