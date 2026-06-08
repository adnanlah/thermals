# Thermal WebUSB Receipts

Small TypeScript Node.js app that uses `node-thermal-printer` to compose ESC/POS receipt data and sends the resulting bytes to a USB thermal printer through the `usb` package's WebUSB API.

## Setup

```bash
corepack yarn install
corepack yarn build
```

Edit `src/config.ts` and replace the placeholder `vendorId` and `productId` values with the VID/PID values you get after installing the WinUSB driver with Zadig.

```ts
vendorId: 0x0000,
productId: 0x0000,
```

Most ESC/POS USB printers expose an OUT endpoint on interface `0`, endpoint `1`. The app auto-discovers an OUT endpoint when possible, but you can hardcode `interfaceNumber`, `endpointNumber`, or `configurationValue` in `src/config.ts` if your printer needs specific values.

## Commands

```bash
corepack yarn list-usb
corepack yarn inspect-printer
corepack yarn test-print
corepack yarn print
corepack yarn print-arabic
corepack yarn list-system-printers
corepack yarn print-system
corepack yarn print-arabic-system
corepack yarn print-arabic-text-system
corepack yarn print-arabic-raw-system
corepack yarn print-arabic-bitmap-system
corepack yarn print-arabic-canvas-system
corepack yarn render-arabic-canvas-bitmap
corepack yarn print-arabic-puppeteer-system
corepack yarn render-arabic-puppeteer-bitmap
```

`list-usb` prints connected USB device descriptors so you can confirm the VID/PID visible to Node.

`inspect-printer` shows the selected configuration, interface, alternate setting, OUT endpoint, endpoint type, and packet size for the hardcoded VID/PID.

`test-print` sends a tiny raw ESC/POS receipt without QR codes or formatting. If `test-print` does not print, the problem is almost certainly the USB interface/endpoint/driver path rather than the receipt layout.

The default receipt intentionally avoids QR/image commands. Once plain text prints reliably, add those features back one at a time because many inexpensive ESC/POS-compatible printers support only a subset of barcode commands.

`print-arabic` prints the Arabic payload from `src/arabicReceipt.ts` using the Arabic code page configured in `src/config.ts`. The default is `WPC1256_ARABIC`. If the text comes out backwards, toggle `reverseArabicOutput` in `src/config.ts`.

Run only one print command at a time. USB printer interfaces can be claimed by one process only, so parallel `test-print` and `print` runs will make one of them fail device selection.

## Windows System Printer Mode

If you want to print by Windows printer name instead of VID/PID, install the printer in Windows and set the exact name in `src/config.ts`:

```ts
export const systemPrinterConfig = {
  printerName: "Xprinter XP-T371U",
  docName: "Thermal Receipt"
};
```

The system-printer commands use `node-thermal-printer` with `interface: "printer:My Printer"` and the app's built-in custom Windows spooler driver, so it does not need old native npm printer packages.

```bash
corepack yarn list-system-printers
corepack yarn print-system
corepack yarn print-arabic-system
```

This route does not use Zadig, WinUSB, VID, or PID. It requires a Windows printer installation and sends RAW ESC/POS bytes to the Windows spooler.

Also note that this mode needs Windows to own the printer as a normal printer device. If you replaced the USB driver with WinUSB in Zadig, switch it back to the Xprinter/USB printer driver before using `printer:My Printer`.

Important: `node-thermal-printer` sends RAW ESC/POS bytes through the Windows spooler. That means Windows does not render Arabic for you in text mode; it still depends on printer firmware/code-page support unless you print Arabic as a bitmap image.

`print-arabic-system` is the recommended Arabic path. It renders Arabic with Windows text shaping into a raster image and sends that image as ESC/POS, so it does not depend on the printer's Arabic code page support. `print-arabic-bitmap-system` is kept as an explicit alias for the same bitmap approach.

`print-arabic-canvas-system` is an alternate Arabic bitmap path that renders the receipt with `node-canvas` instead of PowerShell/System.Drawing. It embeds `src/assets/NotoNaskhArabic-VariableFont_wght.ttf`, draws invoice items as a table, draws global receipt values as opposed label/value rows, and adds a Code 128 barcode from the receipt id before converting to RAW ESC/POS raster bytes. `render-arabic-canvas-bitmap` writes a preview PNG to `dist/arabic-receipt-node-canvas.png` without printing.

The node-canvas helpers accept an optional options object as their last argument. Use `paymentMethod: null` to hide the payment-method line, pass a string to override the receipt payload's `paidWith` value, pass `thankYouMessage` to override the receipt footer text, or pass `printedByMessage` to override the final printed-by line:

```ts
createArabicBitmapReceiptWithNodeCanvas(receipt, bitmapConfig, {
  paymentMethod: null,
  thankYouMessage: "شكرا لتعاملكم معنا",
  printedByMessage: "طبع بواسطة: عدنان"
});
```

The Arabic receipt payload can include `storePhones`, `storeEmail`, `clientName`, `cashierPostNumber`, `thankYouMessage`, and `printedByMessage`. The node-canvas receipt prints the summed item quantity inside the `الصنف` table header.

`print-arabic-puppeteer-system` is another Arabic bitmap path that renders an HTML/CSS receipt in Puppeteer, screenshots the receipt element at the configured supersampling scale, and then uses the same final 1-bit ESC/POS raster conversion. It embeds `src/assets/NotoNaskhArabic-VariableFont_wght.ttf` into the generated HTML so Arabic text rendering is consistent. `render-arabic-puppeteer-bitmap` writes the final monochrome preview to `dist/arabic-receipt-puppeteer.png`.

`print-arabic-text-system` and `print-arabic-raw-system` are diagnostic text-mode paths. They are useful for testing printer firmware code pages, but many low-cost thermal printers print Arabic text bytes as mojibake or Chinese-looking glyphs.

The bitmap Arabic paths are controlled by `arabicBitmapPrinterConfig` in `src/config.ts`. `widthDots` must match the real thermal head width, commonly `576` for 80 mm and `384` for 58 mm printers. The node-canvas and Puppeteer paths render internally at `widthDots * renderScale` using 32-bit RGB/RGBA pixels, then downsample to the printer's final 1-bit ESC/POS raster using `monochromeThreshold`; this avoids the low-quality result you get when Windows or a printer driver scales an ordinary image. If Arabic letters look too heavy or filled in, lower `monochromeThreshold`; if they look too faint or broken, raise it. The node-canvas path uses `fontFamily`, so set it to `"Noto Naskh Arabic"` or `"Arial"` to compare fonts. `printerDpi` is written into the preview PNG metadata and should usually stay at `203`. Set `feedAfterReceiptLines` for the paper feed after the thank-you message. Keep `cutAfterPrint` false for printers without a supported cutter.

Arabic receipt items support unit names and optional line discounts:

```ts
{
  name: "قهوة",
  quantity: 2,
  unitName: "كوب",
  unitPrice: 250,
  discount: { type: "percent", value: 10 }
}
```

Discounts can be `{ type: "percent", value: 10 }` or `{ type: "fixed", value: 25 }`. A receipt can also define `globalDiscount`, which is applied after line discounts and before tax. The calculation order is: line subtotal, line discount, global discount, taxable subtotal, tax, total.

## Windows Notes

On Windows, the `usb` package talks through libusb. If opening the printer fails with `LIBUSB_ERROR_NOT_SUPPORTED`, install the WinUSB driver for the printer with Zadig. The system printer driver and WinUSB driver cannot both own the same USB interface at the same time.
