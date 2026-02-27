import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { base64Data, mimeType } = await req.json();

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
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64Data },
            },
            {
              type: "text",
              text: `Eres un experto en análisis de tickets y facturas. Analiza este ticket/factura y extrae la información exacta.

Responde SOLO con JSON válido, sin markdown ni explicaciones:
{
  "importe": 12.50,
  "fecha": "2024-01-15",
  "comercio": "Nombre del establecimiento",
  "concepto": "Descripción breve del gasto",
  "tipo": "restaurante|transporte|hotel|gasolina|supermercado|otro",
  "confianza": 85
}

- importe: número decimal con el total (sin símbolo €)
- fecha: formato YYYY-MM-DD, null si no visible
- comercio: nombre del establecimiento, null si no visible
- concepto: qué se compró/consumió
- tipo: categoría del gasto
- confianza: 0-100 según legibilidad del ticket

Si no es un ticket/factura, devuelve {"error": "No es un ticket válido"}`,
            },
          ],
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
    return NextResponse.json({ error: "Error al parsear respuesta" });
  }
}
