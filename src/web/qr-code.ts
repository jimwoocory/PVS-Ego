import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type QrCodeInstance = {
  svg(): string;
};

type QrCodeConstructor = new (
  input:
    | string
    | {
        content: string;
        padding?: number;
        width?: number;
        height?: number;
        color?: string;
        background?: string;
        ecl?: "L" | "M" | "Q" | "H";
        join?: boolean;
        container?: string;
      }
) => QrCodeInstance;

const QRCode = require("qrcode-svg") as QrCodeConstructor;

export function qrCodeSvg(content: string): string {
  return new QRCode({
    content,
    padding: 2,
    width: 256,
    height: 256,
    color: "#111111",
    background: "#ffffff",
    ecl: "M",
    join: true,
    container: "svg-viewbox"
  }).svg();
}
