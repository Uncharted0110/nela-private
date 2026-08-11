import { useEffect, useMemo, useState, type CSSProperties } from "react";

export interface ExcelSheetTab {
  name: string;
  rows: string[][];
}

export interface ExcelSheetGridProps {
  /** First row = headers when headerRow is true (default). */
  rows: string[][];
  sheetName?: string;
  /** Optional multi-sheet workbook tabs. When set, enables tab switching. */
  sheets?: ExcelSheetTab[];
  /** Treat row 0 as a styled header bar. */
  headerRow?: boolean;
  /** Optional per-cell background colors as `#RRGGBB` (sparse). */
  cellFills?: Record<string, string>;
  maxRows?: number;
  streaming?: boolean;
}

function colLetter(idx: number): string {
  let n = idx + 1;
  let result = "";
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function cellKey(r: number, c: number): string {
  return `${r}:${c}`;
}

/**
 * Excel-like sheet surface: column letters, row numbers, gridlines, header bar.
 * Supports multiple worksheet tabs when `sheets` is provided.
 */
export default function ExcelSheetGrid({
  rows,
  sheetName = "Sheet1",
  sheets,
  headerRow = true,
  cellFills,
  maxRows = 120,
  streaming = false,
}: ExcelSheetGridProps) {
  const tabs: ExcelSheetTab[] =
    sheets && sheets.length > 0
      ? sheets
      : [{ name: sheetName, rows }];

  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(Math.max(0, activeIdx), Math.max(0, tabs.length - 1));
  const active = tabs[safeIdx] ?? { name: sheetName, rows };

  const sheetKey = tabs.map((t) => t.name).join("\0");
  useEffect(() => {
    setActiveIdx(0);
  }, [sheetKey]);

  const { colCount, displayRows, truncated } = useMemo(() => {
    const cols = active.rows.reduce((m, r) => Math.max(m, r.length), 0);
    const sliced = active.rows.slice(0, maxRows);
    return {
      colCount: Math.max(cols, 1),
      displayRows: sliced,
      truncated: active.rows.length > maxRows,
    };
  }, [active.rows, maxRows]);

  if (
    !active.rows.length ||
    (active.rows.length === 1 && active.rows[0]?.every((c) => !c?.trim()))
  ) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-txt-muted p-4">
        Waiting for spreadsheet cells…
      </div>
    );
  }

  const letters = Array.from({ length: colCount }, (_, i) => colLetter(i));

  return (
    <div className="h-full flex flex-col min-h-0 bg-[#f3f3f3] text-[#1a1a1a]">
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse text-[0.72rem] font-[Segoe_UI,Calibri,Arial,sans-serif] leading-tight">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 w-10 min-w-10 h-5 bg-[#e6e6e6] border border-[#c6c6c6] text-[0.65rem] font-normal text-[#666]" />
              {letters.map((letter) => (
                <th
                  key={letter}
                  className="h-5 min-w-[88px] px-1 bg-[#e6e6e6] border border-[#c6c6c6] text-center text-[0.65rem] font-normal text-[#444] select-none"
                >
                  {letter}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, ri) => {
              const isHeader = headerRow && ri === 0;
              return (
                <tr key={ri}>
                  <th className="sticky left-0 z-10 w-10 min-w-10 bg-[#e6e6e6] border border-[#c6c6c6] text-center text-[0.65rem] font-normal text-[#666] select-none">
                    {ri + 1}
                  </th>
                  {Array.from({ length: colCount }, (_, ci) => {
                    const value = row[ci] ?? "";
                    const fill = cellFills?.[cellKey(ri, ci)];
                    const style: CSSProperties = {};
                    if (fill) {
                      style.backgroundColor = fill.startsWith("#") ? fill : `#${fill}`;
                    } else if (isHeader) {
                      style.backgroundColor = "#217346";
                      style.color = "#ffffff";
                      style.fontWeight = 600;
                    }
                    const urlMatch = value.match(/https?:\/\/[^\s"'<>]+/i);
                    const bareUrl =
                      /^https?:\/\/\S+$/i.test(value.trim()) ? value.trim() : null;
                    return (
                      <td
                        key={ci}
                        className={`min-w-[88px] max-w-[220px] h-[22px] px-1.5 border border-[#d0d0d0] truncate align-middle ${
                          isHeader ? "" : "bg-white hover:bg-[#e8f2fe]"
                        }`}
                        style={style}
                        title={value}
                      >
                        {bareUrl || urlMatch ? (
                          <a
                            href={bareUrl || urlMatch![0]}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#0563c1] underline truncate inline-block max-w-full"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {bareUrl || value}
                          </a>
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {streaming && (
              <tr>
                <th className="sticky left-0 w-10 bg-[#e6e6e6] border border-[#c6c6c6]" />
                <td
                  colSpan={colCount}
                  className="h-[22px] px-1.5 border border-[#d0d0d0] bg-white text-[#217346] italic"
                >
                  Streaming…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 flex items-end gap-0.5 h-7 bg-[#f3f3f3] border-t border-[#c6c6c6] px-1 overflow-x-auto">
        {tabs.map((tab, i) => {
          const activeTab = i === safeIdx;
          return (
            <button
              key={`${tab.name}-${i}`}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={
                activeTab
                  ? "flex items-center h-[26px] px-3 rounded-t-sm bg-white border border-[#c6c6c6] border-b-0 text-[0.72rem] font-semibold text-[#217346] shadow-[inset_0_2px_0_0_#217346]"
                  : "flex items-center h-[26px] px-3 rounded-t-sm bg-[#e6e6e6] border border-transparent text-[0.72rem] font-normal text-[#555] hover:bg-[#ededed]"
              }
            >
              {tab.name}
            </button>
          );
        })}
        {truncated && (
          <span className="ml-2 mb-1 text-[0.65rem] text-[#666] whitespace-nowrap">
            Showing {displayRows.length} of {active.rows.length} rows
          </span>
        )}
      </div>
    </div>
  );
}
