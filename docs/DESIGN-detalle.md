# Búsqueda unificada de hoteles: diseño en detalle

Esta es la versión larga de [DESIGN.md](DESIGN.md). Las decisiones y los números son los mismos; acá cuento el razonamiento detrás de cada una y pongo las tablas completas. (Lo hice de manera narrativa para ir reforzando mis conocimientos a medida que escribo)

## 1. Contexto y problema

Una agente de ventas de una agencia de Neuquén está chateando por WhatsApp con una clienta que quiere "Bariloche, 4 noches, 2 adultos". La (o el) agente necesita ver todas las opciones de los tres proveedores de Trama en una sola lista, rápido, y cada vez más prefiere pedirlo en palabras. Eso define dos piezas: una API `/search` que unifica a los proveedores y transmite resultados por SSE a medida que llegan, y un agente de línea de comandos que usa esa API para contestar un pedido en lenguaje natural.

Llamar a tres APIs en paralelo no es lo difícil. Lo difícil es que cada proveedor habla su propio formato, tarda distinto, falla distinto y, sobre todo, **sus manuales no coinciden con lo que devuelven**:

- **A** dice que las estrellas son obligatorias, y en algunos hoteles no vienen. Dice que "pueden aplicar impuestos en la propiedad" sin aclarar si están en el precio.
- **B** dice que el precio siempre incluye impuestos, y a veces `impuestos_incluidos` llega en `false`. Se le pide `limite=50` y pagina de a 20. Precios en ARS con formato argentino ("1.234.567,89"). El 5% de los pedidos nunca responde.
- **C** publica una tabla de impuestos que no coincide con la real (Cancún: manual 16%, real 19% más USD 4,50 por noche). Devuelve sus errores como HTTP 200 con un `<Fault>` adentro. Corta los nombres a 24 caracteres, no trae coordenadas y acepta 5 pedidos por segundo.

La consecuencia es una regla que atraviesa todo el código: **me apoyo en lo que probé contra los proveedores, no en su documentación**. Cada vez que un manual y una respuesta real no coincidían, ganó la respuesta, y el adaptador quedó escrito para el comportamiento real.

Las decisiones grandes, en una línea cada una:

- Los tres proveedores se consultan en paralelo y cada resultado sale por SSE apenas llega. El `done` sale cuando terminan los tres o a los 5,5 s (más hasta 100 ms de margen) y dice qué proveedor faltó y por qué.
- Un hotel reúne ofertas de varios proveedores, con precio total en USD e impuestos incluidos.
- El dedup une con nombre, calle y número iguales; ante la duda no une y lo explica.
- Cada proveedor falla por separado. B reintenta por detrás y puede quedar incompleto (`partial`).
- El agente usa Gemini, es conversacional, y una verificación en código controla precios y hoteles de su respuesta.

## 2. Cómo fluye una búsqueda

```
Cliente (agente de viajes o agente de IA)
        |  GET /search  (SSE)
        v
   Entrada: valida parámetros, abre el stream
        |
   Orquestador: lanza A, B y C en paralelo, con un tope común de 5,5 s
        |
   +----+-----+-----+
   |          |         |
 Adaptador  Adaptador  Adaptador     (llaman, parsean, pasan el precio a USD total)
   A          B         C
   |          |         |
   +----+-----+-----+
        |
   Dedup y merge: une el mismo hotel de distintos proveedores
        |
   Eventos SSE: search_started, hotel, offer, provider_status, done
```

- **Entrada.** Valida los parámetros y abre el stream. Lo primero que sale es `search_started`, que no depende de ningún proveedor; por eso el primer evento llega a los pocos milisegundos.
- **Orquestador.** Lanza los tres adaptadores a la vez con un tope común. No espera a que terminen todos para emitir: cada proveedor que contesta pasa al dedup y sale por el stream. Cuando vence el tope cancela lo que siga en curso.
- **Adaptadores.** Cada uno traduce a su proveedor al formato común. Todo lo raro (formatos numéricos, impuestos, errores, paginación) termina ahí.
- **Dedup y merge.** Cada proveedor que llega se compara contra los hoteles ya emitidos. Si un hotel ya estaba, sale un `offer` para esa fila; si no, un `hotel` nuevo.
- **Eventos.** El cliente arma la lista a medida que llegan, ve el estado de cada proveedor y recibe en el `done` el resumen de qué faltó.

## 3. Decisiones

### 3.1 Esquema y eventos

**Qué es un hotel.** Id propio, nombre, estrellas, dirección, coordenadas y una lista de ofertas. Estrellas y coordenadas pueden ser `null`: A omite las estrellas en algunos hoteles y C no trae coordenadas. Prefiero un `null` explícito a inventar un valor, porque un dato inventado contamina el dedup (que usa estrellas y coordenadas para confirmar) y le muestra a la agente algo que ningún proveedor dijo.

El id es estable **dentro de una búsqueda, no entre búsquedas**. Sale del primer proveedor que trae el hotel, así que el mismo hotel puede ser `A-…` en una búsqueda y `C-…` en otra si A falla o tarda más. Para el stream alcanza, porque los `offer` tardíos solo necesitan apuntar a una fila ya enviada. La mejora está en la sección 6.

**Qué es una oferta.** Proveedor, tipo de habitación, nombre de la habitación, régimen (RO, BB, HB, FB, AI), capacidad, reembolsable (`true`, `false` o `null` si el proveedor no lo informó) y precio total en USD por toda la estadía, con impuestos incluidos.

El tipo de habitación (`roomType`) es un código común: SGL, DBL, TWN, TPL, FAM o STE. Los tres proveedores usan ese mismo conjunto (A como prefijo de `roomCode`, B en `codigo_habitacion`, C en `room`). Lo verifiqué con datos reales antes de agregarlo, y si llega otro código queda `null`. El nombre (`roomName`) se guarda tal cual, porque viene en tres estilos: inglés en A ("Twin Standard - Bed & breakfast"), español en B ("Doble twin") y solo el código en C ("TWN"). Puse `roomType` en la API y no traduje los nombres solo en el agente, porque cualquier cliente de la API necesita comparar habitaciones, no solo el agente.

**Cómo llego a un precio comparable.** La consigna pide misma moneda y misma base: total de la estadía con impuestos.

- **A** ya viene en USD y por la estadía. Su manual dice que "pueden aplicar impuestos en la propiedad". Asumo que están incluidos porque la Twin de Cabañas Cerro Otto cuesta 766,10 en A y 753,04 en C con impuestos. Hay otra evidencia, débil: en 187 habitaciones iguales (mismo hotel, código y régimen) de A y B, la diferencia de precio mediana es 7,9% (máxima 18,3%), cuando los impuestos de estos destinos van del 5% al 21%. Es débil porque los proveedores también varían el precio entre sí. Es una suposición, no una certeza.
- **B** viene en ARS con formato argentino. Si `impuestos_incluidos` es `false` le sumo `impuestos`, aunque el manual diga que siempre es `true`. Convierto con la cotización del día.
- **C** viene neto por noche. Calculo `nightly * noches * (1 + pct) + perNight * noches`, con la tabla de impuestos que devuelve `HotelTaxRQ`, porque la del manual no coincide con la real.

**Qué emite el stream.** Cinco eventos (tabla completa en 4.1). La idea es que el cliente nunca tenga que adivinar: un hotel nuevo es una fila, una oferta tardía se agrega a una fila que ya existe, un cambio de estado de un proveedor actualiza un aviso, y el `done` cierra diciendo qué faltó. Agregué `provider_status` aparte del `done` porque B puede tardar segundos en reintentar, y la agente tiene que saber en ese momento que todavía falta algo.

### 3.2 Deduplicación

**Qué pasa.** Cada hotel que llega se compara contra cada fuente de los hoteles ya emitidos:

- **Núcleo:** misma calle, mismo número y mismo nombre. Los tres tienen que coincidir.
- **Nombre exacto** (las mismas palabras en cualquier orden, después de normalizar): alcanza con el núcleo.
- **Nombre por tolerancia** (un nombre de C cortado a 24 caracteres): además hace falta un refuerzo presente en los dos y coincidente, es decir, mismas estrellas o coordenadas a 150 m o menos.
- Un refuerzo presente que se contradice (estrellas distintas, coordenadas a más de 150 m) impide la unión; uno ausente no cuenta ni a favor ni en contra.
- Nunca se unen dos hoteles del mismo proveedor, y si dos hoteles ya emitidos califican (empate), no se une con ninguno.

Como los proveedores contestan en momentos distintos, la comparación corre cada vez que llega un proveedor: si se une, sale un `offer`; si no, un `hotel`.

Antes de comparar normalizo: minúsculas, sin tildes ni signos, abreviaturas de C expandidas (CAB, APT, HTL, BTQ, RST, entre otras), sufijo de ciudad fuera (" - Bariloche") y direcciones separadas en calle y número ("avenida" → "av").

**De dónde sale la regla.** Arranqué con "unir si coinciden 4 de 5 señales" (nombre, calle, número, estrellas y coordenadas), con la idea de que ante la duda no se une y se explica. Contadas todas por igual, esa regla se podía cumplir sin que coincidiera la calle, así que separé los datos que identifican al hotel (nombre, calle y número, obligatorios) de los que lo confirman (estrellas o coordenadas). Después la medí contra datos reales y vi que exigir siempre un dato de confirmación separaba 9 pares del mismo hotel, y relajé el caso del nombre exacto (más abajo, el caso de Los Coihues).

**Por qué así.** El nombre solo no alcanza porque es la señal más débil: B invierte el orden de las palabras ("Campanario Apart" frente a "Apart Campanario" de A), C los corta a 24 caracteres y los abrevia, y el catálogo repite nombres con otro tipo y otra dirección. Por eso el núcleo son nombre, calle y número juntos: si coinciden los tres, es muy difícil que sean hoteles distintos. Los que identifican tienen que coincidir siempre. Los que confirman solo se piden cuando la identificación es débil (un nombre truncado), y solo pueden vetar si están presentes en los dos lados y se contradicen. Así un proveedor que no manda estrellas no impide una unión, pero uno que manda estrellas distintas sí.

**Ante la duda no uno.** Unir dos hoteles distintos le muestra a la clienta un precio que no corresponde a ese hotel; un duplicado solo molesta. Por eso, cuando no hay evidencia suficiente, el hotel sale separado y con una nota (`matchNote`) en cuatro situaciones: mismo nombre por tolerancia y misma dirección pero sin refuerzo, un refuerzo que se contradice, misma dirección con otro nombre, y empate. Si solo coincide parte del nombre no hay nota: el catálogo repite nombres con otro tipo y otra dirección (Hotel, Lodge y Apart Catedral), y serían decenas de notas por destino.

La excepción es el nombre exacto con la misma dirección: ahí uno sin pedir refuerzo. Viene de un error de la primera versión. Esa regla siempre exigía estrellas o coordenadas que confirmaran la unión, y "Boutique Hotel Los Coihues - Bariloche" (B, categoría "Boutique", sin estrellas) y "BTQ HTL LOS COIHUES" (C, sin coordenadas), los dos en Elflein 1567, quedaban separados porque no había nada con qué confirmar. Medido contra el catálogo eran 9 pares del mismo hotel separados, todos con el nombre exacto. Con la regla actual las uniones suben de 111 a 120 sin perder ninguna. El costo es el error caro de la sección 4.6: dos hoteles distintos con el mismo nombre y la misma dirección se unen si nada los distingue.

**Cómo lo medí.** Comparé el resultado contra el catálogo del simulador (`packages/mock-kit`, leído solo desde un script fuera del repo): 6 estadías en los 5 destinos y 3 órdenes de llegada. Dio 585 filas, que son los 195 hoteles reales en cada uno de los 3 órdenes, con 0 uniones erróneas y 0 hoteles separados.

Desconfié del resultado perfecto. Para comprobar que la medición detecta errores, rompí la regla a propósito (unir solo por dirección, sin revisar contradicciones) y reportó 3 uniones erróneas. Ignorar solo la calle o solo el nombre no produjo errores con estos datos: esas comprobaciones las cubren tests unitarios, no la medición. El resultado es tan bueno porque el simulador escribe la misma dirección en los tres proveedores y no repite nombres dentro de un destino; con datos reales no lo esperaría. Nada en `apps/` depende del catálogo: en un sistema real esa respuesta correcta no existe.

**Qué descarté.** Exigir siempre un refuerzo (separaba 9 pares reales). Unir por coincidencia parcial de nombre (el catálogo repite nombres en hoteles distintos). Notas para cada coincidencia parcial (ruido). Los casos donde el dedup se equivoca están en 4.6.

### 3.3 Adaptadores

**Qué pasa.** El adaptador es la frontera entre el proveedor y mi dominio. Llama al proveedor, parsea su formato y devuelve hoteles y ofertas en el formato común, con el precio ya en USD. Todo lo raro de un proveedor (fechas, formatos numéricos, impuestos, errores) se queda adentro. No deduplica, no cachea búsquedas y no decide cuándo termina la búsqueda.

**Por qué.** Si los formatos de los proveedores se filtran hacia afuera, cada cambio de un proveedor toca el dedup, el orquestador o el agente. Con la frontera en el adaptador, sumar un cuarto proveedor es un archivo con su adaptador y registrarlo en la lista de proveedores; el resto del sistema no cambia. El contrato del agente también es el de mi API, no el de los proveedores: el agente habla con `/search` por HTTP y nunca ve un formato de proveedor.

**C habla XML** y lo leo con un parser propio de unas 30 líneas (expresiones regulares sobre elementos y atributos, más las entidades XML como `&amp;`) en vez de una dependencia como `fast-xml-parser`. La respuesta de C es plana y casi todo viene en atributos, así que una librería sumaba peso sin resolver nada que esto no cubra. No soporta CDATA, comentarios ni prefijos de namespace: si C empezara a usarlos, el adaptador no reconoce la respuesta y falla con error, en vez de devolver datos inventados. Prefiero que falle a que devuelva algo mal parseado con apariencia de dato válido.

### 3.4 Latencia, streaming y caché

**Qué pasa.** Los tres proveedores se consultan en paralelo y el resultado de cada uno sale por el stream apenas llega. A responde en 150 a 400 ms, así que el primer hotel sale rápido sin esperar a B ni a C.

B entrega todos sus hoteles juntos, al terminar sus páginas, no página por página. Es a propósito: el contrato de los adaptadores devuelve la lista completa, y emitir por página cambiaría la interfaz de los tres. Lo que se gana es poco: el primer hotel viene de A igual, y si B se corta a mitad, el `partial` ya devuelve las páginas que llegaron.

B es el más lento: cada página tarda de 0,8 a 2,5 s y van una tras otra, así que con dos páginas puede llegar a unos 5 s. Si además una página necesita el segundo pedido, puede vencer el tope y B queda incompleto. Pedir las páginas en paralelo no se puede, porque el cursor es opaco y cada página necesita el cursor de la anterior.

C pasa por un limitador propio de 5 pedidos por segundo con ráfaga de 4, no de 5 como el servidor. El primer pedido también abre la conexión y le llega a C más tarde de lo que lo contamos; con ráfaga de 5, el sexto pedido llegaba antes de tiempo y recibía un 429. Lo encontré probando contra el proveedor real, no con los tests. Con ráfaga de 4 queda un turno de margen sin bajar la tasa.

**Cuándo mando `done`.** Cuando terminaron los tres proveedores o a los 5,5 s, lo que pase primero. Al vencer el tope se cancelan los pedidos en curso y se esperan hasta 100 ms más a que los adaptadores lo noten; el que no contestó en ese margen queda en `timeout`. Por eso el `done` p99 da 5513 ms y no 5500.

**Por qué 5,5 s.** La consigna no fija un objetivo para el `done`, así que lo elegí pensando en la agente: pierde más si se pierde la mejor tarifa que si espera un poco más, y mientras tanto ya ve resultados y avisos de qué falta. El tope cubre a B en la gran mayoría de los casos; en cerca del 6,5% de las búsquedas B queda incompleto y se avisa (`partial` o `timeout`). Un tope menor lo perdería más seguido. Descarté un tope de 1,5 s: sería más rápido, pero casi siempre perdería a C. La espera de hasta 5,5 s no bloquea a la agente: el primer hotel aparece a los ~400 ms (p95) y el resto llega a medida que responden los proveedores. El tope solo define cuándo se cierra la búsqueda y cuánto tiempo espero a B y a C antes de avisar que faltan. Cuánta espera tolera una agente real no lo medí: es una suposición, y por eso el tope es una constante fácil de cambiar.

**Caché.** Medí `bun run load` sin caché antes de agregarla, para tener un antes y un después. Guardo cuatro cosas (tabla en 4.2). La búsqueda completa dura 90 s porque el precio es indicativo y se confirma al reservar. Solo guardo búsquedas en las que los tres proveedores terminaron en `ok`, para no repetir una falla durante 90 s. Un acierto repite los eventos con `cached: true`.

La cotización de B y la tabla de impuestos de C son cargas compartidas entre búsquedas. Tienen su propio timeout y no dependen de la señal de la búsqueda que las disparó: si esa búsqueda se cancelaba, fallaban las demás que estaban esperando la misma carga.

**Qué dio la medición** (tabla completa en 4.3). Con chaos activo, primer evento p95 de 5 ms, primer hotel p95 de 401 ms y 0% de errores. El primer evento es `search_started`, así que reporto también el primer hotel, que es lo que de verdad ve la agente. El `done` p95 coincide con el tope porque, sin caché, 13 de 200 búsquedas (6,5%) lo alcanzan, todas por B. La caché baja el `done` p50 de 3 s a 2 ms, porque el 60% del tráfico repite 10 búsquedas, pero casi no mueve el p99: las búsquedas nuevas siguen esperando a B.

**Qué descarté.** Coalescing de búsquedas idénticas en curso: con esta carga solo se habrían unido 6 pedidos de 200, porque casi nunca coinciden dos iguales en el mismo momento. Emitir B por página. Un tope de 1,5 s.

### 3.5 Fallas

**Qué pasa.** Cada proveedor falla por separado y ninguna falla tumba la búsqueda.

- **A:** un reintento ante un 5xx.
- **B:** el 5% de las veces nunca responde. Si un pedido (una página o la cotización) no contesta en 2,6 s, que es el máximo normal de B, lanzo un segundo pedido igual sin cancelar el primero y uso el que llegue antes; el cliente ve `retrying`. Si una página intermedia falla, o vence el tope entre páginas, el adaptador devuelve los hoteles que ya llegaron marcados como incompletos (`PartialResultError`) en vez de descartarlos.
- **C:** ante un 429 espera `Retry-After` sin revisar si cabe dentro del tope, porque el adaptador no conoce el tope: si la búsqueda se cancela mientras espera, informa `rate_limited`. Reintenta como máximo 2 veces ante un 429; al tercero informa `rate_limited` aunque quede tiempo. Ante un GDS-503 (que C devuelve como `<Fault>` dentro de un HTTP 200) reintenta una vez.

**Qué ve el cliente.** Un `provider_status` por proveedor (`ok`, `partial`, `retrying`, `timeout`, `error`, `rate_limited`) y un `done` que resume qué faltó y por qué, con la lista `missing`. "B incompleto" es el estado `partial`: los hoteles que llegaron se muestran igual, y el estado dice cuántos llegaron y por qué se cortó (`timeout` si venció el tope entre páginas, `error` si falló una página).

**Por qué.** Reintentar es seguro porque una búsqueda no cambia nada en el proveedor. Devolver lo que llegó en vez de descartarlo sigue la misma lógica que el tope: 20 hoteles de B con aviso valen más que ninguno.

### 3.6 Agente como harness

**Cómo lo pensé.** El modelo solo interpreta el pedido y redacta la respuesta; lo que hace confiable al agente está alrededor, en código:

- **Herramienta:** una sola, `search_hotels`, con los destinos en lista cerrada y un resultado compacto. El contrato de la herramienta es el de mi API, no el de los proveedores.
- **Contexto:** la fecha de hoy y los destinos válidos van en las instrucciones. Los resultados de búsquedas viejas se compactan y los mensajes del modelo se guardan enteros.
- **Guardarraíles:** la API valida los parámetros (un 400 vuelve al modelo como error de la herramienta), el agente corta después de 3 llamadas a la herramienta, y la verificación de precios y hoteles y el pie con el estado de los proveedores los hace el código, no el modelo.
- **Manejo de errores:** reintentos con tope de 20 s, respuesta vacía y cuota agotada con un mensaje claro.
- **Evals:** 5 casos fijos con la fecha de hoy fija, para detectar si un cambio de modelo o de instrucciones empeora algo.

**Modelo.** `gemini-3.5-flash`. Tiene capa gratuita sin tarjeta, soporta llamar herramientas (lo comprobé con una prueba) y alcanza para una sola herramienta con parámetros simples. Probé antes `gemini-2.5-flash` (ya no está disponible para cuentas nuevas) y `gemini-3.8-flash` (503 por demanda). Consideré Groq (más rápido, solo modelos abiertos) y DeepSeek (requiere saldo).

El modelo se configura con `GEMINI_MODEL` y queda detrás de una capa chica (`llm.ts`, `fetch` directo, sin SDK). Cambiar de proveedor no es tocar un solo archivo: además de `llm.ts`, cambia cómo `agent.ts` guarda el historial, que usa el formato de Gemini (`role: "model"`, `functionCall`, `functionResponse`). La mejora sería un formato de mensajes neutral que `llm.ts` traduzca a cada proveedor.

**Límite real de la capa gratuita:** se agotó con pocas decenas de pedidos en una sesión de desarrollo (evals y pruebas); después Gemini respondió 429 pidiendo esperar unos 55 minutos. Eso explica el manejo de reintentos.

**Reintentos y fallas de Gemini.** Ante 503 o 429 reintenta hasta 3 veces, esperando lo que pide Gemini o 1, 2 y 4 s, y avisa cada reintento ("Gemini ocupado, reintento en 1 s…"). Nunca espera más de 20 s: si la cuota pide más, falla en el momento con un mensaje claro. Antes de ese límite, una cuota agotada dejaba el CLI 55 minutos en silencio y parecía colgado. Si el modelo devuelve una respuesta vacía (sin texto ni llamada a la herramienta), avisa y reintenta una vez; si se repite, mensaje claro. Mientras espera al modelo muestra "Pensando…". La clave nunca aparece en mensajes ni logs.

**Qué hace.** Es conversacional en la terminal (`bun agent "…"`; con la entrada redirigida, cada línea es un mensaje más). La herramienta acepta solo los 5 destinos, en lista cerrada normalizada a minúsculas, porque el modelo devolvió "Bariloche" en la prueba. Llama a mi `/search` por HTTP y lee el SSE a medida que llega para mostrar el progreso de cada proveedor.

**Qué le devuelve al modelo, y qué no.** Le doy lo que necesita para contestar y nada que lo invite a inventar:

- **Por hotel:** nombre, estrellas, `matchNote` si existe y sus 3 ofertas más baratas, con cuántas más hay.
- **Por oferta:** precio total en USD, habitación, régimen, reembolsable y proveedor. La habitación sale de `roomType` en español (Single, Doble, Doble twin, Triple, Familiar, Suite), así no aparece en tres estilos.
- **De la búsqueda:** el estado de cada proveedor (con `partial` y su motivo), `missing` y `cached`.
- **Lo que no le pasa:** direcciones, coordenadas ni tiempos.

Un 400 de la API vuelve al modelo como error de la herramienta; si la API no está levantada, el CLI lo dice sin traza.

**Historial.** Los mensajes del modelo se guardan enteros (Gemini 3 devuelve una `thoughtSignature` que hay que reenviar); solo se compactan los resultados de búsquedas anteriores, que quedan como un resumen de una línea. Compactar los mensajes del modelo rompería la firma; compactar los resultados viejos es lo que mantiene chico el historial.

**Información que falta.** Las fechas nunca se inventan: si faltan, se preguntan, junto con todo lo demás que falte, en un solo mensaje. Si faltan solo los adultos, supone 2 (el valor por defecto de A y de B), busca y avisa que lo supuso, así la agente lo corrige en el siguiente mensaje. Es una suposición mía y no la medí; si prefirieran preguntar siempre, es un cambio de una línea en las instrucciones. La fecha de hoy (hora de Argentina) va en las instrucciones. **Supuesto de "el finde que viene":** del viernes al domingo del próximo fin de semana (si hoy ya es viernes, sábado o domingo, el siguiente), y el agente dice qué fechas usó. Un destino fuera de la lista no se busca: dice cuáles hay.

**Fidelidad a los datos.** No confío solo en el prompt. Después de cada respuesta, `grounding.ts` verifica en código que cada precio en USD coincida con una oferta del último resultado, que cada nombre de hotel exista en él y que se mencione cada proveedor de `missing`. Si falla, avisa y le pide al modelo **una** corrección (el texto ya salió por streaming, así que no se puede borrar). Además, el estado de los proveedores y el aviso de caché los imprime el código al final, así no dependen del modelo. La verificación es heurística sobre texto libre y tiene huecos concretos, listados en 4.4.

**Por qué un solo agente y no varios.** La tarea es una secuencia corta (entender el pedido, buscar, responder) con una única herramienta. Separarla en agentes (uno que interpreta, otro que busca, otro que verifica) sumaría llamadas al modelo y latencia, y gastaría un cupo que ya se me agotó una vez, sin resolver el problema. La verificación la hace código determinista y no un segundo modelo. Lo reconsideraría si el agente tuviera que reservar, comparar contra otras fuentes o hacer tareas largas.

**Cómo lo probé.**

- **Tests sin red (`bun test`)**, con un modelo falso: la herramienta y el historial (partes enteras, compactación); la verificación; los reintentos, el límite de 20 s y la respuesta vacía; una conversación con una lista fija de mensajes.
- **Modo interactivo** del CLI, probado a mano con un pseudo-terminal y un Gemini falso: las líneas escritas mientras el modelo responde quedan en cola; el prompt aparece solo al terminar el turno; el 503, la respuesta vacía y la cuota agotada muestran su aviso.
- **Evals con Gemini real** (`evals.ts`, fecha de hoy fija en el miércoles 28/10/2026), una corrida con el código actual. Resultados en 4.5.
- **Corridas reales para el PR** (`bun agent`, salida cruda en el PR):
  1. Bariloche, pedido completo: B reintentó y quedó `partial` (20 hoteles, se cortó por tiempo); el agente lo avisó y la verificación pasó.
  2. Mendoza sin fechas: no buscó y preguntó las fechas.
  3. Salta con B caído (segunda API con B apuntando a un puerto vacío): B en `error`; el agente lo avisó y mostró A y C.

## 4. Tablas completas

### 4.1 Eventos del stream

| Evento | Cuándo | Qué hace el cliente |
|---|---|---|
| `search_started` | Al arrancar | Muestra qué proveedores se consultan |
| `hotel` | Llega un hotel nuevo | Agrega una fila |
| `offer` | Oferta tardía de un hotel ya mostrado | La agrega a esa fila |
| `provider_status` | Cambia el estado de un proveedor | Actualiza el aviso ("B reintentando") |
| `done` | Terminaron todos o venció el tope | Cierra e informa qué proveedores faltaron y por qué |

Estados de `provider_status`: `ok`, `partial`, `retrying`, `timeout`, `error`, `rate_limited`.

### 4.2 Caché

| Qué se guarda | Cuánto | Por qué |
|---|---|---|
| Búsqueda completa | 90 s | El precio es indicativo; se confirma al reservar |
| Cotización de B | Hasta que cambie el día | El manual dice que se actualiza una vez al día |
| Tabla de impuestos de C | 1 hora | Cambia poco y C tiene límite de pedidos |
| Búsquedas con un proveedor caído | No se guardan | Para no repetir una falla |

### 4.3 `bun run load`, sin caché y con caché

200 búsquedas, 10 a la vez, chaos activo con `CHAOS_SEED=ci`, `bun dev` reiniciado antes de cada medición.

| Medición | Sin caché (p50 / p95 / p99) | Con caché (p50 / p95 / p99) |
|---|---|---|
| Primer evento (`search_started`) | 1 / 5 / 7 ms | 1 / 5 / 7 ms |
| Primer hotel (`firstHotelMs`) | 263 / 401 / 628 ms | 0 / 374 / 467 ms |
| `done` | 3025 / 5504 / 5513 ms | 2 / 4948 / 5513 ms |
| Aciertos de caché | no aplica | 104 de 200 |
| Búsquedas completas | 186 de 200 | 196 de 200 |
| Duración de la corrida | 65,4 s | 34,2 s |
| Tasa de error | 0,00% | 0,00% |

- Primer evento y `done` salen de `bun run load`. Primer hotel, aciertos y búsquedas completas salen de un script aparte con la misma mezcla de tráfico, que lee el `done` de cada búsqueda.
- Con caché, el primer hotel de las 96 búsquedas en vivo da 262 / 433 / 695 ms.
- Sin caché, 13 de 200 búsquedas (6,5%) alcanzan el tope, todas por B: pagina de a 20, las páginas van una tras otra y, si una necesita el pedido de cobertura, no llega. En esas búsquedas B termina en `partial` (11) o `timeout` (2).
- Antes de medir con caché había estimado p50 de unos 5 ms, p95 de unos 4,7 s y 103 aciertos. La medición dio 2 ms, 4,9 s y 104.
- La consigna pide primer evento p95 menor a 800 ms y error de 1% o menos: dio 5 ms y 0,00%.

### 4.4 Lo que la verificación del agente no detecta

`grounding.ts` es heurística sobre texto libre. No detecta:

| Caso | Por qué se escapa |
|---|---|
| Un precio sin marca de moneda ("cuesta 753") o en palabras | Solo reconoce precios en USD escritos como tales |
| Un precio que existe pero atribuido a otro hotel o a otra habitación | Compara contra todas las ofertas, no hotel por hotel |
| Un nombre de hotel sin palabra de tipo ("el Cerro Otto") o en minúsculas | No lo reconoce como nombre de hotel; en cambio, un nombre parcial de uno real pasa ("Hotel Cerro" coincide con "Hotel Cerro Otto") |
| Datos falsos que no son nombres ni precios: régimen, reembolsable, estrellas, fechas | No los verifica |
| Un proveedor faltante mencionado sin decir bien qué le pasó | Solo busca la letra cerca de palabras como "no respondió" o "proveedor" |
| Dos ofertas mezcladas en una línea ("Doble (o Doble twin)", visto en una corrida real) | Solo controla precios, nombres de hotel y proveedores faltantes |

### 4.5 Evals con Gemini real

Fecha de hoy fija en el miércoles 28/10/2026, una corrida con el código actual.

| # | Caso | Qué se espera | Resultado |
|---|---|---|---|
| 1 | Pedido completo | Busca con los parámetros correctos y pasa la verificación | Pasó. Se vieron los reintentos con Gemini real: dos 429 (esperas de 11 s y 0 s) y siguió |
| 2 | Sin fechas | No busca y pregunta las fechas | Pasó |
| 3 | "El finde que viene" | Busca del 30/10 al 1/11 | **Falló.** Buscó del 6 al 8/11 (dijo qué fechas usó). En una corrida anterior, con el mismo prompt y el mismo pedido a Gemini, había pasado: el resultado varía entre corridas |
| 4 | Un proveedor caído | Avisa que B no respondió y pasa la verificación | Pasó. Usa un resultado de búsqueda simulado en el que falta B: prueba cómo el modelo maneja un proveedor faltante, no la cadena completa |
| 5 | Destino inexistente | No busca y nombra los 5 destinos | En la corrida completa no llegó a correr: Gemini respondió 429 pidiendo esperar 24 s (límite por minuto) y el agente no espera más de 20 s. Corrido solo un minuto después, pasó |

Documenté el fallo del eval 3 en vez de parcharlo a último momento. El arreglo está en la sección 6.

### 4.6 Casos del dedup

| Caso | Origen | Qué pasa | Por qué |
|---|---|---|---|
| Cabañas Cerro Otto (A) y CAB CERRO OTTO (C) | Datos reales | Se unen | Mismo nombre después de expandir CAB, misma calle y número |
| "Hotel Colonia Suiza" (A, Moreno 233) y "CAB COLONIA SUIZA" (C, Pioneros 682) | Datos reales | Quedan separados, sin nota | Solo comparten "Colonia Suiza"; tipo y dirección son otros |
| "Boutique Hotel Los Coihues - Bariloche" (B) y "BTQ HTL LOS COIHUES" (C), Elflein 1567 | Datos reales, regla anterior | Con la regla anterior quedaban separados; hoy se unen | La regla anterior exigía siempre un refuerzo y B no tenía estrellas ni C coordenadas. Eran 9 pares así |
| "Grand Resort Isla Mujeres" (A) y "Grand Resort Zona Hotelera" (B y C), los dos en Blvd. Kukulcán km 579, Cancún | Datos reales, con test | Quedan separados: B y C se unen entre sí, y esa fila sale con la nota "misma dirección con otro nombre" | Es el único caso de los datos donde dos hoteles distintos comparten dirección. El nombre es otro y las coordenadas de A y B están a más de 150 m |
| Dos hoteles distintos con el mismo nombre y la misma dirección | Construido, con test | **Se unen (error caro)** | Con nombre exacto no pido refuerzo y un refuerzo ausente no cuenta en contra. Lo acepto porque exigir refuerzo separaba 9 pares reales y en los datos no hay nombres con dirección repetidos |
| Empate por orden de llegada: B y C traen el mismo hotel sin poder confirmarse (B sin estrellas, C con nombre truncado) y después llega A, que coincide con los dos | Construido, con test | A no se une con ninguno; el hotel aparece tres veces | Ante un empate no elijo. La mejora sería un evento para fusionar filas ya enviadas |
| "Av. Bustillo km 8,5" y "Av. Bustillo 8500" | Construido, con test | Duplicado, sin nota | No reconozco las dos formas como la misma dirección |
| "Panamericano Hotel" y "Panamericano Hotel & Spa", misma dirección | Construido, con test | No se unen; el segundo sale con "misma dirección con otro nombre" | El nombre no coincide exacto ni por tolerancia |

Medición contra el catálogo del simulador: 585 filas (195 hoteles reales en cada uno de 3 órdenes de llegada), 0 uniones erróneas, 0 hoteles separados. Con la regla rota a propósito (solo dirección, sin contradicciones): 3 uniones erróneas.

## 5. Trade-offs

**Esperar hasta 5,5 s por completitud.** Todas las búsquedas nuevas en que B tarda esperan hasta el tope, y el `done` p95 queda pegado a él. A cambio, B entra en la gran mayoría de las búsquedas. La agente no espera a ciegas: ve hoteles desde los 400 ms y sabe qué proveedor falta. Subir el tope recuperaría parte del 6,5% en que B queda incompleto, a costa de hacer esperar más a todas las búsquedas en que B tarda.

**No unir ante la duda.** Acepto duplicados para no mostrar precios de otro hotel. Un duplicado se ve; un precio equivocado no, hasta que la clienta llega al hotel.

**Relajar el dedup con nombre exacto.** Unir con nombre exacto, calle y número sin pedir refuerzo recupera 9 pares reales que la regla estricta separaba, y abre la puerta al error caro: dos hoteles distintos con el mismo nombre y la misma dirección. Lo tomé porque el primer problema existe en los datos y el segundo no, y el segundo tiene su test.

**El agente atado a Gemini.** La capa `llm.ts` es chica y sin SDK, pero el historial de `agent.ts` usa el formato de Gemini. Cambiar de proveedor toca los dos archivos. Elegí Gemini por su capa gratuita sin tarjeta, y el formato de mensajes neutral que lo desataría queda en la sección 6.

**Parser XML propio.** Ahorro una dependencia a cambio de no soportar CDATA, comentarios ni namespaces. Si C los empieza a usar, el adaptador falla con error en vez de devolver datos inventados.

**Reglas de fechas en el prompt.** "El finde que viene" lo calcula el modelo y no el código. Con el mismo prompt el eval 3 pasó una vez y falló otra. El agente siempre dice qué fechas usó, así que el error se ve, pero no es determinístico.

## 6. Qué dejé afuera

- **Fechas de "el finde que viene" calculadas en código:** hoy la regla vive solo en el prompt y la cuenta la hace el modelo. Calcular esas fechas en código y dárselas al modelo como dato quita la variación del eval 3.
- **Evento para fusionar filas ya enviadas:** resolvería el empate por orden de llegada, a costa de que el cliente tenga que poder unir o quitar filas.
- **Nombres abreviados de C:** cada fila muestra el nombre del proveedor que la creó, así que un hotel que solo tiene C, o que C trajo primero, aparece como "HTL CERRO OTTO" o "BTQ HTL VIRREYES". Mejoraría preferir el nombre de A o B cuando llegan después, o embellecer los de C (expandir abreviaturas, mayúsculas y minúsculas).
- **Id de hotel estable entre búsquedas:** hoy sale del primer proveedor que trae el hotel. Un id derivado del nombre normalizado más calle y número sería el mismo en todas las búsquedas, sin importar quién conteste primero.
- **Subir el tope del `done`:** recuperaría parte de las búsquedas en que B queda incompleto, a costa de que todas las búsquedas nuevas en que B tarda esperen más.
- **Pedir las páginas de B en paralelo:** hoy no se puede, porque el cursor es opaco y cada página necesita el cursor de la anterior.
- **Coalescing de búsquedas idénticas en curso:** con esta carga solo se habrían unido 6 pedidos de 200. Si se agrega, la desconexión de un cliente no debe cancelar una búsqueda que otros siguen esperando.
- **Limpieza de la caché:** las entradas vencidas se borran solo cuando alguien vuelve a pedir esa búsqueda. En un servidor que corre mucho tiempo, las búsquedas que nadie repite quedan en memoria; haría falta una limpieza periódica o un tamaño máximo.
- **Varias instancias:** el límite de 5 pedidos por segundo de C es global. Con más de una copia de la API habría que compartir ese contador.
- **Ejecución durable:** el sistema solo consulta, así que repetir una búsqueda es seguro. Con reservas haría falta persistir estado e idempotency keys.
- **Confirmación de precio al reservar:** el precio mostrado es indicativo.
- **Dedup perfecto:** no está garantizado con proveedores reales; el 0 de errores medido es optimista por lo limpio del simulador.
- **Detectar una unión errónea en producción:** hoy no la detectaría solo. Haría falta medir contra una muestra revisada a mano, o contra un identificador común entre proveedores, y sumar señales que distingan hoteles gemelos (teléfono, o el código de la propiedad que dan algunos proveedores).
- **Datos que la agente debería pedir antes de buscar** (destino, fechas, personas): hoy lo resuelve el agente preguntando.
- **Una oferta por línea:** en una corrida real, el modelo escribió "Doble (o Doble twin)" para un mismo hotel, mezclando dos ofertas en una línea. La verificación no lo detecta.
- **Formato de mensajes neutral** entre `agent.ts` y `llm.ts`, para cambiar de proveedor de LLM tocando solo la capa.
- **Lo que no llegué a hacer:** una prueba de estrés del dedup con datos alterados a propósito (direcciones escritas distinto, hoteles gemelos), porque la medición contra el simulador no ejercita algunas reglas; y un test automático del modo interactivo del CLI (lo probé a mano en un pseudo-terminal, pero no entra en `bun test`).

## 7. Cómo usé la IA

Usé Claude en el chat para entender el problema, separarlo en capas y tomar las decisiones de diseño, y Claude Code para escribir los adaptadores, el dedup, el orquestador y el agente, siempre pidiéndole primero el plan y aprobando cada paso. Un `CLAUDE.md` le fijó las reglas duras: no tocar `providers/`, no leer el `.env` y avanzar de a un paso.

**Dónde ayudó.** Probando contra los proveedores reales encontró lo que los manuales no decían: B pagina de a 20 aunque se pida `limite=50`, a veces no incluye impuestos, y C devuelve sus errores como HTTP 200 con un `<Fault>`. También midió el dedup contra el catálogo del simulador y rompió la regla a propósito para comprobar que la medición detectaba errores.

**Dónde se equivocó o tuve que corregirlo, y cómo lo noté.**

- El chat me dijo que A devolvía 19 hoteles para Bariloche y eran 20. Lo vi al probar contra el proveedor real.
- Diagnosticó mal un fallo del CLI: lo atribuyó al modo interactivo, y la causa principal era una cuota agotada de Gemini que dejaba la espera en silencio. Claude Code lo reprodujo en un pseudo-terminal y lo corrigió.
- Dos datos que yo le pasé sobre los evals eran incorrectos; los verificó contra git antes de escribirlos.
- Mi script de prueba hacía fallar `bun typecheck` en el CI. Lo detectó Claude Code al revisar.
- Antes de entregar, hice que una sesión nueva de Claude Code, sin el contexto de la construcción, comparara DESIGN.md con el código. Encontró dos afirmaciones falsas: que el id del hotel era estable entre búsquedas y que cambiar de proveedor de LLM tocaba un solo archivo. Las corregí.

**Lo que decidí yo.** Esperar más por más opciones antes del `done`, avisando qué falta. No unir hoteles ante la duda. Separar los datos que identifican un hotel de los que lo confirman. Medir antes de agregar la caché. Que el agente sea conversacional. Documentar los fallos de los evals en vez de parchearlos.

El detalle de cada sesión está en [AI_LOG.md](../AI_LOG.md).

## 8. Idea central

Ninguna pieza de este sistema puede confiar del todo en la anterior. Los manuales de los proveedores no describen lo que devuelven, un proveedor puede no contestar, dos nombres parecidos pueden no ser el mismo hotel y el modelo puede escribir un precio que no existe. En cada una de esas fronteras puse algo verificable en vez de una suposición: adaptadores escritos contra respuestas reales, un dedup que ante la duda separa y lo explica, un `done` que dice qué faltó, y código que revisa la respuesta del modelo. Lo que no resolví queda escrito con el caso que lo muestra.
