import {
  Device,
  WebUSB,
  getDeviceList
} from "usb";
import { UsbPrinterConfig } from "./config";

type UsbEndpointDescriptor = {
  endpointNumber: number;
  direction: "in" | "out";
  type?: "bulk" | "interrupt" | "isochronous";
  packetSize?: number;
};

type UsbAlternateDescriptor = {
  alternateSetting: number;
  interfaceClass?: number;
  interfaceSubclass?: number;
  interfaceProtocol?: number;
  endpoints: UsbEndpointDescriptor[];
};

type UsbInterfaceDescriptor = {
  interfaceNumber: number;
  alternate?: UsbAlternateDescriptor;
  alternates: UsbAlternateDescriptor[];
};

type UsbConfigurationDescriptor = {
  configurationValue: number;
  interfaces: UsbInterfaceDescriptor[];
};

type UsbPipe = {
  configurationValue: number;
  interfaceNumber: number;
  alternateSetting: number;
  endpointNumber: number;
  endpointType?: string;
  packetSize?: number;
  interfaceClass?: number;
};

export type WebUsbPrintResult = {
  bytesWritten: number;
  chunksWritten: number;
  pipe: UsbPipe;
};

export function listUsbDevices(): string[] {
  return getDeviceList().map(formatUsbDevice);
}

export async function printBufferOverWebUsb(
  config: UsbPrinterConfig,
  data: Buffer
): Promise<WebUsbPrintResult> {
  assertConfiguredIds(config);

  const webusb = new WebUSB({
    allowAllDevices: true,
    devicesFound: async (devices) =>
      devices.find(
        (device) =>
          device.vendorId === config.vendorId &&
          device.productId === config.productId
      )
  });

  const device = await webusb.requestDevice({
    filters: [{ vendorId: config.vendorId, productId: config.productId }]
  });

  const pipe = resolveUsbPipe(device, config);
  let bytesWritten = 0;
  let chunksWritten = 0;

  try {
    await device.open();

    if (!device.configuration) {
      await device.selectConfiguration(pipe.configurationValue);
    }

    await device.claimInterface(pipe.interfaceNumber);

    if (pipe.alternateSetting !== 0) {
      await device.selectAlternateInterface(
        pipe.interfaceNumber,
        pipe.alternateSetting
      );
    }

    await softResetPrinterClassInterface(device, config, pipe);

    for (const chunk of chunks(data, getChunkSize(config, pipe))) {
      const result = await device.transferOut(
        pipe.endpointNumber,
        bufferToExactArrayBuffer(chunk)
      );

      if (result.status !== "ok") {
        throw new Error(
          `USB transfer failed on endpoint ${pipe.endpointNumber}: ${result.status}`
        );
      }

      if (result.bytesWritten !== chunk.byteLength) {
        throw new Error(
          `USB transfer wrote ${result.bytesWritten} of ${chunk.byteLength} bytes on endpoint ${pipe.endpointNumber}.`
        );
      }

      bytesWritten += result.bytesWritten;
      chunksWritten += 1;
      await delay(config.interChunkDelayMs);
    }

    await delay(config.postWriteDelayMs);
    return { bytesWritten, chunksWritten, pipe };
  } finally {
    await closeQuietly(device, pipe.interfaceNumber);
  }
}

export async function describeConfiguredUsbPrinter(
  config: UsbPrinterConfig
): Promise<string[]> {
  assertConfiguredIds(config);

  const webusb = new WebUSB({
    allowAllDevices: true,
    devicesFound: async (devices) =>
      devices.find(
        (device) =>
          device.vendorId === config.vendorId &&
          device.productId === config.productId
      )
  });

  const device = await webusb.requestDevice({
    filters: [{ vendorId: config.vendorId, productId: config.productId }]
  });
  const selectedPipe = resolveUsbPipe(device, config);
  const lines = [
    `Device ${toHexId(device.vendorId)}:${toHexId(device.productId)}`,
    `Selected OUT pipe: configuration=${selectedPipe.configurationValue}, interface=${selectedPipe.interfaceNumber}, alternate=${selectedPipe.alternateSetting}, endpoint=${selectedPipe.endpointNumber}, type=${selectedPipe.endpointType ?? "unknown"}, packetSize=${selectedPipe.packetSize ?? "unknown"}`
  ];

  for (const configuration of device.configurations as UsbConfigurationDescriptor[]) {
    lines.push(`Configuration ${configuration.configurationValue}`);

    for (const usbInterface of configuration.interfaces) {
      for (const alternate of usbInterface.alternates) {
        const endpoints = alternate.endpoints
          .map(
            (endpoint) =>
              `${endpoint.direction} ep${endpoint.endpointNumber} ${endpoint.type ?? "unknown"} packet=${endpoint.packetSize ?? "?"}`
          )
          .join(", ");

        lines.push(
          `  interface=${usbInterface.interfaceNumber} alternate=${alternate.alternateSetting} class=${formatClassCode(alternate.interfaceClass)} subclass=${formatClassCode(alternate.interfaceSubclass)} protocol=${formatClassCode(alternate.interfaceProtocol)} endpoints=[${endpoints}]`
        );
      }
    }
  }

  return lines;
}

function assertConfiguredIds(config: UsbPrinterConfig): void {
  if (config.vendorId === 0x0000 || config.productId === 0x0000) {
    throw new Error(
      "Set usbPrinterConfig.vendorId and usbPrinterConfig.productId in src/config.ts before printing."
    );
  }
}

function resolveUsbPipe(
  device: USBDevice,
  config: UsbPrinterConfig
): UsbPipe {
  const configurations = device.configurations as UsbConfigurationDescriptor[];
  const selectedConfiguration =
    configurations.find(
      (configuration) =>
        configuration.configurationValue === config.configurationValue
    ) ?? configurations[0];

  if (!selectedConfiguration) {
    throw new Error("USB device has no readable configurations.");
  }

  const candidates: UsbPipe[] = [];

  for (const usbInterface of selectedConfiguration.interfaces) {
    if (
      config.interfaceNumber !== undefined &&
      usbInterface.interfaceNumber !== config.interfaceNumber
    ) {
      continue;
    }

    for (const alternate of usbInterface.alternates) {
      if (
        config.alternateSetting !== undefined &&
        alternate.alternateSetting !== config.alternateSetting
      ) {
        continue;
      }

      const endpoint = alternate.endpoints.find(
        (candidate) =>
          candidate.direction === "out" &&
          (config.endpointNumber === undefined ||
            candidate.endpointNumber === config.endpointNumber)
      );

      if (endpoint) {
        candidates.push({
          configurationValue: selectedConfiguration.configurationValue,
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          endpointNumber: endpoint.endpointNumber,
          endpointType: endpoint.type,
          packetSize: endpoint.packetSize,
          interfaceClass: alternate.interfaceClass
        });
      }
    }
  }

  const bestCandidate = candidates.sort(compareUsbPipes)[0];

  if (bestCandidate) {
    return bestCandidate;
  }

  throw new Error(
    "Could not find a USB OUT endpoint. Set interfaceNumber and endpointNumber in src/config.ts."
  );
}

function compareUsbPipes(left: UsbPipe, right: UsbPipe): number {
  return scoreUsbPipe(right) - scoreUsbPipe(left);
}

function scoreUsbPipe(pipe: UsbPipe): number {
  let score = 0;

  if (pipe.interfaceClass === 0x07) score += 100;
  if (pipe.endpointType === "bulk") score += 50;
  if (pipe.alternateSetting === 0) score += 10;

  return score;
}

function chunks(buffer: Buffer, chunkSizeBytes: number): Buffer[] {
  const size = Math.max(1, chunkSizeBytes);
  const parts: Buffer[] = [];

  for (let offset = 0; offset < buffer.length; offset += size) {
    parts.push(buffer.subarray(offset, offset + size));
  }

  return parts;
}

function getChunkSize(config: UsbPrinterConfig, pipe: UsbPipe): number {
  const configuredSize = Math.max(1, config.chunkSizeBytes);

  if (!pipe.packetSize) {
    return configuredSize;
  }

  return Math.max(1, Math.min(configuredSize, pipe.packetSize));
}

async function softResetPrinterClassInterface(
  device: USBDevice,
  config: UsbPrinterConfig,
  pipe: UsbPipe
): Promise<void> {
  if (!config.softResetPrinterClassInterface || pipe.interfaceClass !== 0x07) {
    return;
  }

  try {
    const result = await device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request: 0x02,
      value: 0x0000,
      index: pipe.interfaceNumber
    });

    if (result.status === "ok") {
      await delay(100);
    }
  } catch {
    // Some printers do not implement the USB printer-class soft reset request.
  }
}

function bufferToExactArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

async function closeQuietly(
  device: USBDevice,
  interfaceNumber: number
): Promise<void> {
  try {
    if (device.opened) {
      await device.releaseInterface(interfaceNumber);
    }
  } catch {
    // The printer may already have been disconnected or released.
  }

  try {
    if (device.opened) {
      await device.close();
    }
  } catch {
    // Closing should not hide the original print error.
  }
}

function formatUsbDevice(device: Device): string {
  const descriptor = device.deviceDescriptor;
  const vendorId = toHexId(descriptor.idVendor);
  const productId = toHexId(descriptor.idProduct);
  const bus = device.busNumber ?? "?";
  const address = device.deviceAddress ?? "?";

  return `${vendorId}:${productId} bus=${bus} address=${address}`;
}

function toHexId(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function formatClassCode(value: number | undefined): string {
  return value === undefined ? "?" : toHexId(value);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}
