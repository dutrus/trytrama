# Take-home Trama: búsqueda unificada de hoteles

Antes de codear leé docs/CHALLENGE.md y docs/DESIGN.md. DESIGN.md tiene las decisiones tomadas.
Si algo no está claro, revisá el código y lo que conversamos. Si seguís con dudas, preguntame.
No inventes requisitos ni hagas cambios fuera de lo que te pedí.

## Reglas duras
- NO modifiques providers/ ni packages/mock-kit/ (son sistemas externos simulados).
- NO importes nada de providers/ ni de packages/mock-kit/ en apps/api o apps/agent. Hablá con los proveedores solo por HTTP (puertos 4001, 4002, 4003).
- NO leas, imprimas ni commitees .env. La clave se lee de process.env.GEMINI_API_KEY.
- Pocas dependencias; justificá cada una.
- Un commit por paso, con mensaje claro.
- Un paso por vez: esperá mi OK antes de pasar al siguiente.

## Trampas de los proveedores (los manuales mienten)
- A: puede faltar starRating y refundable. Guardar null, no inventar.
- B: números "1.234.567,89" y fechas DD/MM/YYYY. Si impuestos_incluidos es false, sumar "impuestos". El 5% de los pedidos nunca responde.
- C: tarifa neta por noche. La tabla de impuestos real sale de HotelTaxRQ; la del manual está desactualizada. Sin coordenadas. Límite 5 req/s.
- Gemini devuelve el destino con mayúscula ("Bariloche"): normalizar.
- Los mensajes del modelo van ENTEROS en el historial (thoughtSignature); solo se compactan los resultados de búsqueda.

## Comandos
bun dev | bun test | bun typecheck | bun run load
Windows PowerShell: variables con $env:NOMBRE="valor"

## Orden de construcción
1. types.ts, cache.ts, providers/a.ts + test
2. providers/b.ts y c.ts + tests
3. normalize.ts y dedup.ts + tests
4. search.ts, sse.ts, index.ts
5. bun run load
6. agente