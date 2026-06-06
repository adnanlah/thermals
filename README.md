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
```

`list-usb` prints connected USB device descriptors so you can confirm the VID/PID visible to Node.

`inspect-printer` shows the selected configuration, interface, alternate setting, OUT endpoint, endpoint type, and packet size for the hardcoded VID/PID.

`test-print` sends a tiny raw ESC/POS receipt without QR codes or formatting. If `test-print` does not print, the problem is almost certainly the USB interface/endpoint/driver path rather than the receipt layout.

The default receipt intentionally avoids QR/image commands. Once plain text prints reliably, add those features back one at a time because many inexpensive ESC/POS-compatible printers support only a subset of barcode commands.

Run only one print command at a time. USB printer interfaces can be claimed by one process only, so parallel `test-print` and `print` runs will make one of them fail device selection.

## Windows Notes

On Windows, the `usb` package talks through libusb. If opening the printer fails with `LIBUSB_ERROR_NOT_SUPPORTED`, install the WinUSB driver for the printer with Zadig. The system printer driver and WinUSB driver cannot both own the same USB interface at the same time.
