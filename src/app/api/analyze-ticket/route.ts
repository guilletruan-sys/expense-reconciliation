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
      model: "claude-sonnet-4-6-20250227",
      max_tokens: 2000,
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
              text: `Analiza esta imagen de un ticket, factura o recibo con máxima precisión. Examina cada detalle visible en la imagen.

INSTRUCCIONES:
1. Lee TODO el texto visible en la imagen, incluyendo texto pequeño, borroso o en los márgenes
2. Busca el TOTAL FINAL (no subtotales ni parciales). Suele aparecer al final, en negrita o con mayor tamaño. Busca palabras como "TOTAL", "IMPORTE", "A PAGAR", "TOTAL EUR"
3. La fecha puede estar en cualquier formato (DD/MM/YYYY, DD-MM-YYYY, etc.). Los tickets españoles usan DD/MM/YYYY
4. El nombre del comercio suele estar arriba del ticket, a veces con CIF/NIF debajo
5. Si la imagen está rotada o invertida, intenta leerla igualmente

Responde SOLO con JSON válido, sin markdown, sin explicaciones, sin texto adicional:
{
  "importe": 12.50,
  "fecha": "2024-01-15",
  "comercio": "Nombre exacto del establecimiento",
  "concepto": "Descripción de lo consumido/comprado",
  "tipo": "restaurante|transporte|hotel|gasolina|supermercado|parking|farmacia|otro",
  "confianza": 85
}

Reglas para cada campo:
- importe: número decimal del TOTAL FINAL (sin símbolo €). Si hay varios totales, usa el más grande
- fecha: formato YYYY-MM-DD. Si el ticket pone 15/03/2024, devuelve "2024-03-15". null si no visible
- comercio: nombre tal cual aparece en el ticket. null si no legible
- concepto: resumen breve (ej: "comida y bebidas", "gasolina 95", "parking 2h")
- tipo: categoría más apropiada
- confianza: 0-100. Baja si hay zonas ilegibles o borrosas

Si la imagen NO es un ticket/factura/recibo, devuelve: {"error": "No es un ticket válido"}`,
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
