# AI log

# AI log

Using AI is allowed and expected. We care about **how** you use it, not whether you do.

You can paste full transcripts (or links), or summarize each session using the format below.
It doesn't need to be polished.

---

## Session 1

- **Tool / model:** Claude (chat)
- **Goal:** <!-- what you asked for --> Entender el problema y tomar las decisiones de diseño antes de escribir código. Probar cada proveedor a mano y elegir el modelo para el agente.
- **What went well:** Probando cada proveedor con curl encontré que los manuales no coinciden con la realidad: B dice "siempre con impuestos" y a veces no los incluye, y la tabla de impuestos de C no coincide con su manual en Cancún (19% más USD 4,50 por noche, el manual decía 16%). Con el modelo pasó algo parecido: gemini-2.5-flash ya no está disponible para cuentas nuevas (404) y gemini-3.8-flash devolvió 503 por demanda, así que probé hasta encontrar uno que anduviera (gemini-3.5-flash).
- **What went wrong or had to be corrected:** <!-- and how you noticed --> El chat me propuso empezar con código (tipos y el adaptador de A) y yo pedí volver al diseño primero. También me dijo que A devolvía 19 hoteles para Bariloche y eran 20: lo detecté al probar contra el proveedor real. Además expuse mi clave de Gemini en una captura de pantalla: la borré y creé una nueva.
- **What you decided, not the AI:**
  - Esperar un poco más para tener más opciones antes de mandar `done`, pero avisando qué proveedor falta.
  - Unir hoteles solo con evidencia fuerte; ante la duda no unir, pero explicarlo.
  - Que el agente sea conversacional (con historial), no de una sola respuesta.
  - Usar Gemini, y dejar Groq y DeepSeek anotadas como alternativas.
  - Que el reintento a B corra por detrás mientras el stream sigue abierto.

<!-- Transcript or relevant excerpts (optional) -->

---

## Session 2

- **Tool / model:** Claude Code
- **Goal:** Tipos, caché y adaptadores de A, B y C, con tests (pasos 1 y 2 del orden de construcción).
- **What went well:** Le di un `CLAUDE.md` con reglas duras (no tocar `providers/`, no leer `.env`, un paso por vez) y le pedí el plan antes del código. Probó los adaptadores contra los proveedores reales y encontró cosas que los manuales no decían: B ignora `limite=50` y pagina de a 20, trae categoría "Boutique" y coordenadas nulas, y los errores de C llegan como HTTP 200 con un `<Fault>`. También le pedí que comparara el DESIGN con el código y me avisara las diferencias sin arreglarlas, y encontró cinco.
- **What went wrong or had to be corrected:**
  - Mi script de prueba (`ping.ts`) hacía fallar `bun typecheck` en el CI. Lo detectó Claude Code al revisar.
  - Con el límite de C (5 pedidos por segundo), el 6.º pedido recibía un 429. Lo encontró probando contra el proveedor real, no con los tests, y bajó la ráfaga a 4.
  - Una carga compartida (cotización de B, impuestos de C) dependía de la señal de la primera búsqueda: si esa búsqueda se cancelaba, fallaban las demás. Lo señaló él mismo y lo pedí corregir.
- **What you decided, not the AI:** Qué hacer si una página de B falla a mitad (devolver lo que hay, marcando incompleto), un reintento ante GDS-503 de C, y que cada paso se apruebe antes de pasar al siguiente.

---

## Session 3 (en curso)

- **Tool / model:** Claude Code y Claude (chat)
- **Goal:** Regla para decidir cuándo dos resultados son el mismo hotel.
- **What went well:** Pedí que probara la regla sobre los datos reales de los 5 destinos y me mostrara las uniones una por una, para revisarlas a ojo antes de escribir código.
- **What went wrong or had to be corrected:** PENDIENTE
- **What you decided, not the AI:**
  - Separar los datos que identifican al hotel (nombre, calle, número) de los que lo confirman (estrellas, coordenadas), en vez de contarlos todos igual.
  - Adoptar la regla de nombre exacto: sube de 111 a 120 uniones sin perder ninguna.
  - Medirla contra el catálogo del simulador usado como respuesta correcta, solo en un script descartable fuera del repo. Nada en `apps/` depende de él, y en un sistema real esa respuesta no existe.
  - Resultado de esa medición: - **What went wrong or had to be corrected:** La primera regla exigía un refuerzo (estrellas o coordenadas) siempre, y separaba 9 pares que eran el mismo hotel. Lo vimos al medirla contra datos reales, y cambié a nombre exacto más calle y número. Al validar la medición, romper la regla ignorando calle o nombre no produjo errores: el simulador es demasiado limpio, y esas comprobaciones solo están cubiertas por tests unitarios.
- Resultado de la medición contra el catálogo del simulador: 195 hoteles, 6 estadías y 3 órdenes de llegada, 0 uniones erróneas y 0 separados. Un resultado optimista: el simulador usa la misma dirección en todos los proveedores.