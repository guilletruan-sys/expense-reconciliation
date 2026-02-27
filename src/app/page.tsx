"use client";

import { useState, useRef } from "react";
import * as XLSX from "xlsx";

// ─── UTILS ─────────────────────────────────────────────────────────────────
const formatAmount = (n: number) => `${parseFloat(String(n)).toFixed(2)} €`;
const formatDate = (d: unknown): string => {
  if (!d) return "—";
  try {
    if (d instanceof Date) return d.toLocaleDateString("es-ES");
    if (typeof d === "number") {
      const date = new Date(Math.round((d - 25569) * 86400 * 1000));
      return date.toLocaleDateString("es-ES");
    }
    return new Date(String(d)).toLocaleDateString("es-ES");
  } catch {
    return String(d);
  }
};

const scoreColor = (s: number) =>
  s >= 80 ? "score-high" : s >= 50 ? "score-med" : "score-low";

// ─── TYPES ─────────────────────────────────────────────────────────────────
interface Movement {
  _fecha: unknown;
  _importe: number;
  _concepto: string;
  _raw: unknown[];
}

interface TicketData {
  importe?: number;
  fecha?: string;
  comercio?: string;
  concepto?: string;
  tipo?: string;
  confianza?: number;
  error?: string;
}

interface Ticket {
  name: string;
  file: File;
  status: "pending" | "processing" | "done" | "error";
  data: TicketData | null;
  preview: string | null;
}

interface MatchEntry {
  movimiento_idx: number;
  ticket_idx: number;
  score: number;
  razon: string;
}

interface MatchResult {
  matches: MatchEntry[];
  movimientos_sin_ticket: number[];
  tickets_sin_movimiento: number[];
  resumen?: string;
}

// ─── API CALLS ────────────────────────────────────────────────────────────
async function analyzeTicket(base64Data: string, mimeType: string): Promise<TicketData> {
  const res = await fetch("/api/analyze-ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Data, mimeType }),
  });
  return res.json();
}

async function matchExpenses(
  movements: { idx: number; fecha: string; importe: number; concepto: string }[],
  tickets: { idx: number; filename: string; fecha?: string; importe?: number; comercio?: string; concepto?: string }[]
): Promise<MatchResult> {
  const res = await fetch("/api/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ movements, tickets }),
  });
  return res.json();
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState(0);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [colMap, setColMap] = useState<Record<string, string>>({ fecha: "", importe: "", concepto: "" });
  const [excelHeaders, setExcelHeaders] = useState<string[]>([]);
  const [excelRaw, setExcelRaw] = useState<unknown[][]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [, setProgress] = useState(0);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [modal, setModal] = useState<{ type: string; data: Ticket } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragOverTickets, setDragOverTickets] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const ticketRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string, type = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── EXCEL UPLOAD ──
  const handleExcelFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target?.result, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];

      // Find the header row: first row with 2+ non-empty text cells
      let headerIdx = 0;
      for (let i = 0; i < Math.min(data.length, 10); i++) {
        const row = data[i];
        if (!row) continue;
        const textCells = row.filter(
          (c) => c !== null && c !== undefined && c !== "" && typeof c === "string" && isNaN(Number(c))
        );
        if (textCells.length >= 2) {
          headerIdx = i;
          break;
        }
      }

      const headerRow = data[headerIdx] || [];
      // Determine max columns from all rows
      const maxCols = data.reduce((max, row) => Math.max(max, row?.length || 0), 0);

      // Build headers: use actual values if they exist, otherwise fallback to column letters
      const headers: string[] = [];
      for (let i = 0; i < maxCols; i++) {
        const val = headerRow[i];
        if (val !== null && val !== undefined && String(val).trim() !== "") {
          headers.push(String(val).trim());
        } else {
          headers.push(`Columna ${String.fromCharCode(65 + i)}`);
        }
      }

      const rows = data.slice(headerIdx + 1).filter((r) => r && r.some((c) => c !== null && c !== undefined && c !== ""));
      setExcelHeaders(headers);
      setExcelRaw(rows);

      // Auto-detect columns
      const autoMap: Record<string, string> = { fecha: "", importe: "", concepto: "" };
      headers.forEach((h, i) => {
        const hl = h.toLowerCase();
        if (!autoMap.fecha && (hl.includes("fech") || hl.includes("date")))
          autoMap.fecha = String(i);
        if (
          !autoMap.importe &&
          (hl.includes("importe") || hl.includes("amount") || hl.includes("cargo") || hl.includes("abono") || hl.includes("valor"))
        )
          autoMap.importe = String(i);
        if (
          !autoMap.concepto &&
          (hl.includes("concepto") || hl.includes("descr") || hl.includes("concept") || hl.includes("detalle"))
        )
          autoMap.concepto = String(i);
      });
      setColMap(autoMap);
      showToast(`✓ ${rows.length} movimientos cargados`, "success");
    };
    reader.readAsArrayBuffer(file);
  };

  const applyColumnMap = () => {
    if (!colMap.importe) {
      showToast("Selecciona al menos la columna de importe", "error");
      return;
    }
    const mapped = excelRaw
      .map((row) => ({
        _fecha: colMap.fecha ? (row as unknown[])[parseInt(colMap.fecha)] : null,
        _importe: parseFloat(String((row as unknown[])[parseInt(colMap.importe)]).replace(",", ".")) || 0,
        _concepto: colMap.concepto ? String((row as unknown[])[parseInt(colMap.concepto)] || "") : "",
        _raw: row as unknown[],
      }))
      .filter((r) => r._importe !== 0);
    setMovements(mapped);
    setStep(1);
    showToast(`✓ ${mapped.length} movimientos procesados`, "success");
  };

  // ── TICKET UPLOAD ──
  const handleTicketFiles = async (files: FileList) => {
    const newTickets = Array.from(files).filter(
      (f) => f.type.startsWith("image/") || f.type === "application/pdf"
    );
    if (!newTickets.length) {
      showToast("Sube imágenes (JPG, PNG) o PDFs", "warning");
      return;
    }

    const entries: Ticket[] = newTickets.map((f) => ({
      name: f.name,
      file: f,
      status: "pending",
      data: null,
      preview: null,
    }));

    for (const entry of entries) {
      if (entry.file.type.startsWith("image/")) {
        entry.preview = URL.createObjectURL(entry.file);
      }
    }

    setTickets((prev) => [...prev, ...entries]);

    for (const entry of entries) {
      setTickets((prev) =>
        prev.map((t) => (t.name === entry.name ? { ...t, status: "processing" } : t))
      );

      const base64 = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = (e) => res((e.target?.result as string).split(",")[1]);
        reader.readAsDataURL(entry.file);
      });

      try {
        const result = await analyzeTicket(base64, entry.file.type);
        entry.data = result;
        setTickets((prev) =>
          prev.map((t) =>
            t.name === entry.name
              ? { ...t, status: result.error ? "error" : "done", data: result }
              : t
          )
        );
      } catch {
        setTickets((prev) =>
          prev.map((t) =>
            t.name === entry.name
              ? { ...t, status: "error", data: { error: "Error de conexión" } }
              : t
          )
        );
      }
    }
  };

  // ── MATCHING ──
  const runMatching = async () => {
    const doneTickets = tickets.filter((t) => t.status === "done");
    if (!doneTickets.length) {
      showToast("Espera a que terminen de procesarse los tickets", "warning");
      return;
    }
    setLoading(true);
    setLoadingMsg("Analizando y cruzando datos con IA...");
    setProgress(30);
    try {
      const movSummary = movements.map((m, i) => ({
        idx: i,
        fecha: formatDate(m._fecha),
        importe: m._importe,
        concepto: m._concepto,
      }));
      const tickSummary = doneTickets.map((t, i) => ({
        idx: i,
        filename: t.name,
        fecha: t.data?.fecha,
        importe: t.data?.importe,
        comercio: t.data?.comercio,
        concepto: t.data?.concepto,
      }));
      const result = await matchExpenses(movSummary, tickSummary);
      setProgress(100);
      setMatchResult(result);
      setStep(2);
      showToast(`✓ ${result.matches?.length || 0} matches encontrados`, "success");
    } catch {
      showToast("Error al hacer el matching", "error");
    }
    setLoading(false);
    setLoadingMsg("");
    setProgress(0);
  };

  // ── EXPORT EXCEL ──
  const exportToExcel = () => {
    if (!matchResult) return;
    const wb = XLSX.utils.book_new();

    // Hoja 1: Resumen
    const resumenData = [
      ["INFORME DE CONCILIACIÓN DE GASTOS"],
      ["Fecha del informe", new Date().toLocaleDateString("es-ES")],
      [],
      ["RESUMEN"],
      ["Total movimientos", total],
      ["Conciliados (con ticket)", matched],
      ["Sin ticket", sinTicket],
      ["Tickets sin movimiento", ticketsSinMov],
      ["% Conciliación", `${pct}%`],
      [],
      ["Análisis IA", matchResult.resumen || "—"],
    ];
    const wsResumen = XLSX.utils.aoa_to_sheet(resumenData);
    wsResumen["!cols"] = [{ wch: 30 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");

    // Hoja 2: Movimientos conciliados
    if (matchResult.matches.length > 0) {
      const matchRows = matchResult.matches.map((m) => {
        const mov = movements[m.movimiento_idx];
        const tick = tickets[m.ticket_idx];
        return {
          "Score (%)": m.score,
          "Fecha movimiento": formatDate(mov?._fecha),
          "Importe (€)": mov?._importe,
          "Concepto bancario": mov?._concepto || "—",
          "Ticket": tick?.name || "—",
          "Fecha ticket": tick?.data?.fecha || "—",
          "Comercio": tick?.data?.comercio || "—",
          "Tipo": tick?.data?.tipo || "—",
          "Razón match": m.razon,
        };
      });
      const wsMatches = XLSX.utils.json_to_sheet(matchRows);
      wsMatches["!cols"] = [{ wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 35 }, { wch: 25 }, { wch: 15 }, { wch: 25 }, { wch: 15 }, { wch: 35 }];
      XLSX.utils.book_append_sheet(wb, wsMatches, "Conciliados");
    }

    // Hoja 3: Sin ticket
    if (sinTicket > 0) {
      const sinTicketRows = matchResult.movimientos_sin_ticket
        .map((idx) => movements[idx])
        .filter(Boolean)
        .map((mov) => ({
          "Fecha": formatDate(mov._fecha),
          "Importe (€)": mov._importe,
          "Concepto": mov._concepto || "—",
          "Estado": "Falta ticket",
        }));
      const wsSinTicket = XLSX.utils.json_to_sheet(sinTicketRows);
      wsSinTicket["!cols"] = [{ wch: 18 }, { wch: 12 }, { wch: 40 }, { wch: 15 }];
      XLSX.utils.book_append_sheet(wb, wsSinTicket, "Sin ticket");
    }

    // Hoja 4: Tickets sin movimiento
    if (ticketsSinMov > 0) {
      const ticketsSinMovRows = matchResult.tickets_sin_movimiento
        .map((idx) => tickets[idx])
        .filter(Boolean)
        .map((t) => ({
          "Ticket": t.name,
          "Importe (€)": t.data?.importe || "—",
          "Fecha": t.data?.fecha || "—",
          "Comercio": t.data?.comercio || "—",
          "Tipo": t.data?.tipo || "—",
          "Estado": "Sin movimiento asociado",
        }));
      const wsTicketsSinMov = XLSX.utils.json_to_sheet(ticketsSinMovRows);
      wsTicketsSinMov["!cols"] = [{ wch: 25 }, { wch: 12 }, { wch: 15 }, { wch: 25 }, { wch: 15 }, { wch: 25 }];
      XLSX.utils.book_append_sheet(wb, wsTicketsSinMov, "Tickets sin movimiento");
    }

    // Descargar
    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `conciliacion_${fecha}.xlsx`);
    showToast("✓ Excel descargado", "success");
  };

  // ── STATS ──
  const matched = matchResult?.matches?.length || 0;
  const total = movements.length;
  const sinTicket = matchResult?.movimientos_sin_ticket?.length || 0;
  const ticketsSinMov = matchResult?.tickets_sin_movimiento?.length || 0;
  const pct = total ? Math.round((matched / total) * 100) : 0;

  return (
    <div className="app">
      {/* HEADER */}
      <header className="header">
        <div className="logo">
          <div className="logo-mark">₹</div>
          <div className="logo-text">
            Expense<span>Match</span>
          </div>
        </div>
        {movements.length > 0 && (
          <div className="header-stats">
            <div className="stat-pill">
              <b>{movements.length}</b> movimientos
            </div>
            <div className="stat-pill">
              <b>{tickets.filter((t) => t.status === "done").length}</b> tickets
            </div>
            {matchResult && (
              <div className="stat-pill">
                <b>{pct}%</b> conciliado
              </div>
            )}
          </div>
        )}
      </header>

      <div className="main">
        {/* STEPPER */}
        <div className="stepper">
          {["Extracto bancario", "Tickets", "Resultados"].map((label, i) => (
            <div
              key={i}
              className={`step ${step === i ? "active" : ""} ${step > i ? "done" : ""}`}
              onClick={() => step > i && setStep(i)}
            >
              <div className="step-num">{step > i ? "✓" : i + 1}</div>
              <div className="step-label">{label}</div>
            </div>
          ))}
        </div>

        {/* STEP 0: EXCEL */}
        {step === 0 && (
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">Cargar extracto bancario</div>
              {excelRaw.length > 0 && (
                <span className="badge badge-info">{excelRaw.length} filas detectadas</span>
              )}
            </div>
            <div className="panel-body">
              {!excelRaw.length ? (
                <div
                  className={`upload-zone ${dragOver ? "drag" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); handleExcelFile(e.dataTransfer.files[0]); }}
                  onClick={() => fileRef.current?.click()}
                >
                  <div className="upload-icon">📊</div>
                  <div className="upload-title">Arrastra tu Excel o haz clic</div>
                  <div className="upload-sub">Formatos: .xlsx — Primera fila = cabeceras</div>
                  <input ref={fileRef} type="file" accept=".xlsx,.xls" hidden onChange={(e) => handleExcelFile(e.target.files?.[0])} />
                </div>
              ) : (
                <>
                  <div className="section-title">Mapear columnas</div>
                  <div className="col-mapper" style={{ marginBottom: 24 }}>
                    {[
                      { key: "fecha", label: "📅 Columna FECHA" },
                      { key: "importe", label: "💶 Columna IMPORTE *" },
                      { key: "concepto", label: "📝 Columna CONCEPTO / DESCRIPCIÓN" },
                    ].map(({ key, label }) => (
                      <div className="col-row" key={key}>
                        <div className="col-label">{label}</div>
                        <select value={colMap[key]} onChange={(e) => setColMap((p) => ({ ...p, [key]: e.target.value }))}>
                          <option value="">— No mapear —</option>
                          {excelHeaders.map((h, i) => (
                            <option key={i} value={String(i)}>{h}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  <div className="section-title">Vista previa</div>
                  <div style={{ overflowX: "auto", marginBottom: 24, maxHeight: 280, overflowY: "auto", borderRadius: 8, border: "1px solid var(--border)" }}>
                    <table className="data-table">
                      <thead>
                        <tr>{excelHeaders.map((h, i) => <th key={i}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {excelRaw.slice(0, 8).map((row, i) => (
                          <tr key={i}>
                            {excelHeaders.map((_, j) => <td key={j}>{String((row as unknown[])[j] ?? "")}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ display: "flex", gap: 12 }}>
                    <button className="btn btn-primary" onClick={applyColumnMap}>Confirmar y continuar →</button>
                    <button className="btn btn-secondary" onClick={() => { setExcelRaw([]); setExcelHeaders([]); }}>Cambiar archivo</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* STEP 1: TICKETS */}
        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Subir tickets</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {tickets.filter((t) => t.status === "processing").length > 0 && (
                    <span className="badge badge-warning">
                      <div className="spinner" style={{ width: 12, height: 12 }} />
                      Procesando...
                    </span>
                  )}
                  <span className="badge badge-success">{tickets.filter((t) => t.status === "done").length} listos</span>
                </div>
              </div>
              <div className="panel-body">
                <div
                  className={`upload-zone ${dragOverTickets ? "drag" : ""}`}
                  style={{ padding: 32, marginBottom: 24 }}
                  onDragOver={(e) => { e.preventDefault(); setDragOverTickets(true); }}
                  onDragLeave={() => setDragOverTickets(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOverTickets(false); handleTicketFiles(e.dataTransfer.files); }}
                  onClick={() => ticketRef.current?.click()}
                >
                  <div className="upload-icon">🧾</div>
                  <div className="upload-title">Arrastra los tickets aquí</div>
                  <div className="upload-sub">JPG, PNG — Múltiples archivos a la vez</div>
                  <input ref={ticketRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && handleTicketFiles(e.target.files)} />
                </div>

                {tickets.length > 0 && (
                  <div className="ticket-grid">
                    {tickets.map((t, i) => (
                      <div
                        key={i}
                        className={`ticket-card ${t.status === "done" && matchResult?.matches?.some((m) => m.ticket_idx === tickets.indexOf(t)) ? "matched" : t.status === "done" ? "unmatched" : ""}`}
                        onClick={() => t.status === "done" && setModal({ type: "ticket", data: t })}
                      >
                        <div className="ticket-img">
                          {t.preview ? (
                            <img src={t.preview} alt={t.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          ) : (
                            <span>📄</span>
                          )}
                        </div>
                        {t.status === "processing" && <div className="ticket-processing"><div className="spinner" /></div>}
                        <div className="ticket-info">
                          <div className="ticket-name">{t.name}</div>
                          {t.data?.importe && <div className="ticket-amount">{formatAmount(t.data.importe)}</div>}
                          {t.data?.fecha && <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{t.data.fecha}</div>}
                          {t.data?.error && <div style={{ fontSize: 10, color: "var(--danger)" }}>{t.data.error}</div>}
                        </div>
                        <div className="ticket-badge">
                          {t.status === "done" && !t.data?.error && <span className="badge badge-success" style={{ fontSize: 10, padding: "2px 6px" }}>✓</span>}
                          {t.status === "error" && <span className="badge badge-danger" style={{ fontSize: 10, padding: "2px 6px" }}>✗</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {tickets.length === 0 && (
                  <div className="empty">
                    <div className="empty-icon">🧾</div>
                    <div className="empty-text">Todavía no has subido tickets</div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "center" }}>
              <button className="btn btn-secondary" onClick={() => setStep(0)}>← Volver</button>
              <button
                className="btn btn-primary"
                onClick={runMatching}
                disabled={loading || tickets.filter((t) => t.status === "done").length === 0}
              >
                {loading ? (
                  <><div className="spinner" />{loadingMsg}</>
                ) : (
                  <>🤖 Analizar y cruzar datos →</>
                )}
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: RESULTADOS */}
        {step === 2 && matchResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div className="grid-4">
              <div className="metric-card">
                <div className="metric-label">Total movimientos</div>
                <div className="metric-value">{total}</div>
                <div className="metric-sub">en el extracto</div>
              </div>
              <div className="metric-card" style={{ borderColor: "rgba(46,213,115,0.3)" }}>
                <div className="metric-label">Con ticket</div>
                <div className="metric-value" style={{ color: "var(--success)" }}>{matched}</div>
                <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%`, background: "var(--success)" }} /></div>
                <div className="metric-sub">{pct}% conciliado</div>
              </div>
              <div className="metric-card" style={{ borderColor: "rgba(255,71,87,0.3)" }}>
                <div className="metric-label">Sin ticket</div>
                <div className="metric-value" style={{ color: "var(--danger)" }}>{sinTicket}</div>
                <div className="metric-sub">movimientos pendientes</div>
              </div>
              <div className="metric-card" style={{ borderColor: "rgba(255,165,2,0.3)" }}>
                <div className="metric-label">Tickets sin movimiento</div>
                <div className="metric-value" style={{ color: "var(--warning)" }}>{ticketsSinMov}</div>
                <div className="metric-sub">no cruzados</div>
              </div>
            </div>

            {matchResult.resumen && (
              <div style={{ background: "rgba(232,255,71,0.05)", border: "1px solid rgba(232,255,71,0.2)", borderRadius: 12, padding: "16px 20px", fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--accent)", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span>🤖</span>
                <span>{matchResult.resumen}</span>
              </div>
            )}

            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Movimientos conciliados</div>
                <span className="badge badge-success">{matched} matches</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Score</th><th>Fecha mov.</th><th>Importe</th><th>Concepto bancario</th>
                      <th>Ticket</th><th>Fecha ticket</th><th>Comercio</th><th>Razón</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchResult.matches.map((m, i) => {
                      const mov = movements[m.movimiento_idx];
                      const tick = tickets[m.ticket_idx];
                      return (
                        <tr key={i}>
                          <td><span className={`match-score ${scoreColor(m.score)}`}>{m.score}%</span></td>
                          <td>{formatDate(mov?._fecha)}</td>
                          <td style={{ color: "var(--accent)", fontWeight: 600 }}>{formatAmount(mov?._importe)}</td>
                          <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mov?._concepto || "—"}</td>
                          <td>
                            <span style={{ cursor: "pointer", color: "var(--accent2)", textDecoration: "underline" }} onClick={() => tick && setModal({ type: "ticket", data: tick })}>
                              {tick?.name}
                            </span>
                          </td>
                          <td>{tick?.data?.fecha || "—"}</td>
                          <td>{tick?.data?.comercio || "—"}</td>
                          <td style={{ color: "var(--muted)", fontSize: 11 }}>{m.razon}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {sinTicket > 0 && (
              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">⚠️ Movimientos sin ticket</div>
                  <span className="badge badge-danger">{sinTicket}</span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead><tr><th>Fecha</th><th>Importe</th><th>Concepto</th><th>Estado</th></tr></thead>
                    <tbody>
                      {matchResult.movimientos_sin_ticket.map((idx) => {
                        const mov = movements[idx];
                        return mov ? (
                          <tr key={idx}>
                            <td>{formatDate(mov._fecha)}</td>
                            <td style={{ color: "var(--danger)", fontWeight: 600 }}>{formatAmount(mov._importe)}</td>
                            <td>{mov._concepto || "—"}</td>
                            <td><span className="badge badge-danger">❌ Falta ticket</span></td>
                          </tr>
                        ) : null;
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {ticketsSinMov > 0 && (
              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">🔍 Tickets sin movimiento</div>
                  <span className="badge badge-warning">{ticketsSinMov}</span>
                </div>
                <div style={{ padding: "0 0 4px 0" }}>
                  <table className="data-table">
                    <thead><tr><th>Ticket</th><th>Importe</th><th>Fecha</th><th>Comercio</th><th>Estado</th></tr></thead>
                    <tbody>
                      {matchResult.tickets_sin_movimiento.map((idx) => {
                        const t = tickets[idx];
                        return t ? (
                          <tr key={idx}>
                            <td style={{ color: "var(--accent2)" }}>{t.name}</td>
                            <td>{t.data?.importe ? formatAmount(t.data.importe) : "—"}</td>
                            <td>{t.data?.fecha || "—"}</td>
                            <td>{t.data?.comercio || "—"}</td>
                            <td><span className="badge badge-warning">⚠️ Sin cruzar</span></td>
                          </tr>
                        ) : null;
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12 }}>
              <button className="btn btn-secondary" onClick={() => setStep(1)}>← Añadir más tickets</button>
              <button className="btn btn-secondary" onClick={() => { setStep(0); setMovements([]); setTickets([]); setMatchResult(null); setExcelRaw([]); }}>
                🔄 Nueva conciliación
              </button>
              <button className="btn btn-primary" onClick={exportToExcel}>
                📥 Descargar Excel resumen
              </button>
            </div>
          </div>
        )}
      </div>

      {/* MODAL TICKET DETAIL */}
      {modal?.type === "ticket" && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ fontWeight: 700 }}>{modal.data.name}</div>
              <button className="btn btn-secondary" style={{ padding: "6px 12px" }} onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {modal.data.preview && (
                <img src={modal.data.preview} alt="" style={{ width: "100%", borderRadius: 8, marginBottom: 16, maxHeight: 300, objectFit: "contain", background: "var(--bg)" }} />
              )}
              {modal.data.data && !modal.data.data.error ? (
                <div style={{ display: "grid", gap: 10 }}>
                  {([
                    ["💶 Importe", modal.data.data.importe ? formatAmount(modal.data.data.importe) : "—"],
                    ["📅 Fecha", modal.data.data.fecha || "—"],
                    ["🏪 Comercio", modal.data.data.comercio || "—"],
                    ["📝 Concepto", modal.data.data.concepto || "—"],
                    ["🏷️ Tipo", modal.data.data.tipo || "—"],
                    ["🎯 Confianza OCR", modal.data.data.confianza ? `${modal.data.data.confianza}%` : "—"],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                      <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{label}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600 }}>{value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "var(--danger)", fontFamily: "var(--font-mono)" }}>{modal.data.data?.error || "Sin datos"}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div className="toast" style={{ borderColor: toast.type === "success" ? "var(--success)" : toast.type === "error" ? "var(--danger)" : "var(--border)" }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
