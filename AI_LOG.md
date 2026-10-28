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

## Session 3

- **Tool / model:** Claude Code y Claude (chat)
- **Goal:** Regla para decidir cuándo dos resultados son el mismo hotel.
- **What went well:** Pedí que probara la regla sobre los datos reales de los 5 destinos y me mostrara las uniones una por una, para revisarlas a ojo antes de escribir código. Así se vio que la primera regla (siempre exigir estrellas o coordenadas que confirmaran) separaba 9 pares que eran el mismo hotel, y cambié a nombre exacto más calle y número.
- **What went wrong or had to be corrected:** Medida contra el catálogo del simulador, la regla dio 0 errores, y desconfié del resultado perfecto. Pedí romper la regla a propósito para comprobar que la medición detectaba errores: ignorar la calle o el nombre no produjo ninguno (el simulador es demasiado limpio, esas comprobaciones solo las cubren los tests unitarios), y con roturas más fuertes sí aparecieron. Además pedí un test del error caro (dos hoteles distintos con el mismo nombre y dirección se unen), que no existía.
- **What you decided, not the AI:**
  - Separar los datos que identifican al hotel (nombre, calle, número) de los que lo confirman (estrellas, coordenadas), en vez de contarlos todos igual.
  - Adoptar la regla de nombre exacto: sube de 111 a 120 uniones sin perder ninguna.
  - No presentar Los Coihues como un error actual sino como historia de la regla anterior.
  - Medir la regla contra el catálogo del simulador usado como respuesta correcta, solo en un script descartable fuera del repo. Nada en `apps/` depende de él, y en un sistema real esa respuesta no existe.
  - Dejar la caché y el coalescing para después de medir el load test sin caché, para tener un antes y un después.
- **Resultado de la medición:** 195 hoteles, 6 estadías y 3 órdenes de llegada, 0 uniones erróneas y 0 separados. Es un resultado optimista: el simulador usa la misma dirección en todos los proveedores.

---

## Session 4: API completa, load test y agente

- **Tool / model:** Claude Code (código) y Claude (chat, revisión de cada plan)
- **Goal:** Orquestador, `/search` con SSE, load test, caché y agente con Gemini.
- **What went well:**
  - En cada paso pedí el plan antes del código y lo revisé.
  - Medí `bun run load` con el ruido activo (`CHAOS_SEED=ci`) y reinicié `bun dev` antes de cada medición para que el antes y el después fueran comparables: primer evento p95 de 5 ms y 0% de errores. Como el primer evento es `search_started`, pedí medir también el tiempo al primer hotel (p95 de 401 ms).
  - Antes de agregar `roomType` a la API, Claude Code verificó con datos reales que los tres proveedores usan los mismos 6 códigos.
  - Las 3 corridas reales del agente para el PR salieron con el ruido real del simulador: en una, B terminó en `partial` y el agente lo avisó; en otra, con B caído, mostró A y C.
  - Antes de entregar le pedí a Claude Code que comparara las afirmaciones concretas de `DESIGN.md` con el código (el tope de 5,5 s, los 2,6 s de B, la caché de 90 s, el limitador de C, los reintentos, los eventos y los estados, entre otras). Todo coincidía salvo dos detalles: el DESIGN no mencionaba que C reintenta como máximo 2 veces ante un 429, y el encabezado `# Design` estaba repetido. Lo corregí a mano. Solo se pudo comprobar lo que tiene un número o un nombre en el código; no revisó cada frase de razonamiento.
- **What went wrong or had to be corrected:**
  - Al verificar la API con los proveedores en `CHAOS=off` los tiempos eran de milisegundos y no servían para medir. Lo noté por los registros y reinicié con el ruido activo.
  - Un artículo al inicio de una oración ("El Hotel Catedral") hacía que la verificación del agente tomara un hotel existente como desconocido. Lo encontró y lo corrigió Claude Code antes de commitear.
  - Probando el agente a mano en PowerShell encontré dos fallos que los tests con modelo falso no veían: el prompt `>` aparecía en medio de la respuesta anterior y, después de escribir mi respuesta, no salía nada. Mi primer diagnóstico (con el chat) apuntaba al modo interactivo del CLI y no era la causa principal: Gemini respondía 429 por cuota agotada con una espera de unos 55 minutos, y la capa de Gemini esperaba en silencio. Claude Code lo reprodujo en un pseudo-terminal y lo confirmó. Además encontró que lo escrito mientras el modelo respondía se perdía y que una respuesta vacía no se manejaba. Arreglo: esperas máximas de 20 s, avisos "Pensando…" y de cada reintento, y reintento ante respuesta vacía.
  - El eval de "el finde que viene" pasó una vez y falló otra con el mismo prompt y el mismo pedido a Gemini: el modelo eligió otro fin de semana. Siempre declaró las fechas que usaba, pero la regla vive solo en el prompt y no es determinística.
  - Dos datos que yo había pasado a Claude Code (que el eval 5 no había corrido y que el eval 3 falló "con el mismo código") eran incorrectos; los verificó contra git y contra la corrida real antes de escribirlos en DESIGN.
- **What you decided, not the AI:**
  - Esperar la medición sin caché antes de implementar la caché.
  - Poner `roomType` en la API y no traducir los nombres de habitación solo en el agente.
  - Que el pie con el estado de los proveedores lo imprima el código y no dependa del modelo.
  - Que el agente sea conversacional, con historial.
  - Probar el agente a mano además de con tests, y pedir la salida cruda de cada corrida, sin resumir.
  - Documentar el fallo del eval 3 y dejar el arreglo (calcular en código las fechas del fin de semana) para después de abrir el PR, en vez de parcharlo a último momento.