import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { movements, tickets } = await req.json();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 500 });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: `Eres un experto en conciliación de gastos. Relaciona estos movimientos bancarios con estos tickets.

MOVIMIENTOS BANCARIOS:
${JSON.stringify(movements, null, 2)}

TICKETS/FACTURAS:
${JSON.stringify(tickets, null, 2)}

Devuelve SOLO JSON válido:
{
  "matches": [
    {
      "movimiento_idx": 0,
      "ticket_idx": 1,
      "score": 95,
      "razon": "Mismo importe y fecha coincide"
    }
  ],
  "movimientos_sin_ticket": [2, 5],
  "tickets_sin_movimiento": [3],
  "resumen": "Texto breve del resultado"
}

Reglas:
- score 0-100 según confianza del match
- Usa importe como criterio principal, fecha como secundario, comercio/concepto como terciario
- Tolerancia de fecha: ±2 días para compensar procesamiento bancario
- Un movimiento solo puede matchear con un ticket y viceversa
- Si el importe no coincide exactamente pero es muy cercano (diferencia < 0.02€), considéralo match`,
        },
      ],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || "{}";
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json({
      matches: [],
      movimientos_sin_ticket: [],
      tickets_sin_movimiento: [],
    });
  }
}
