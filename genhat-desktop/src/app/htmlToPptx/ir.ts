import type { PxRect } from "./geometry.ts";
import type { LinearGrad } from "./cssFill.ts";

export type IrFill =
  | { kind: "solid"; color: string }
  | { kind: "grad"; grad: LinearGrad };

export type IrNode =
  | {
      kind: "shape";
      rect: PxRect;
      fill?: IrFill;
      strokeColor?: string;
      strokeWidthPx: number;
      radiusPx: number;
      opacity: number;
    }
  | {
      kind: "text";
      rect: PxRect;
      text: string;
      fontSizePt: number;
      fontFace: string;
      bold: boolean;
      italic: boolean;
      color: string;
      align: "left" | "center" | "right";
    }
  | {
      kind: "image";
      rect: PxRect;
      dataUrl: string;
    };
