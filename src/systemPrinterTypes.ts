export type SystemPrinterInfo = {
  name?: string;
  status?: string;
  attributes?: string[];
};

export type SystemPrinterDriver = {
  getPrinters(): SystemPrinterInfo[];
  getPrinter(printerName: string): SystemPrinterInfo | undefined;
  printDirect(options: {
    data: Buffer;
    printer: string;
    type: "RAW";
    docname?: string | false;
    success(jobId: string | number): void;
    error(error: unknown): void;
  }): void;
};
