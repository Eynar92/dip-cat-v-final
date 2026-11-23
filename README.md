# Evaluación de comprobantes con k6

Este proyecto utiliza k6 para evaluar el flujo de creación de comprobantes de Financiero de MinkaSoftware. Recorre autenticación, contexto contable, formulario, búsqueda de cuentas, guardado, consulta de persistencia y descarga del PDF. Permite ejecutar pruebas desde el equipo local, enviar sus métricas a Grafana Cloud o generar la carga desde la infraestructura de Grafana.

## Requisitos e instalación

- Node.js con npm.
- Grafana k6 **v2.3.0**, instalado por separado.
- Acceso al ambiente de prueba y un usuario autorizado para crear comprobantes.
- Para las modalidades híbrida y cloud, credenciales y stack de Grafana Cloud k6.

```powershell
git clone https://github.com/Eynar92/dip-cat-v-final.git
cd dip-cat-v-final
npm ci
Copy-Item .env.example .env
```

En `.env`, sustituye los placeholders por tus valores locales:

```text
FINANCIERO_USER=<usuario>
FINANCIERO_PASSWORD=<contraseña>
FINANCIERO_BASE_URL=<URL del ambiente>
K6_CLOUD_TOKEN=<token de Grafana Cloud>
K6_CLOUD_STACK_ID=<identificador del stack>
K6_CLOUD_PROJECT_ID=<identificador del proyecto de k6, opcional>
```

El usuario y la contraseña son obligatorios en todas las modalidades. El token y el stack solo son necesarios para híbrida y cloud. `K6_CLOUD_PROJECT_ID` permite seleccionar el proyecto de destino; no es el mismo identificador que el stack. Si no se utiliza, omite esa variable. Los secretos no se versionan ni se imprimen en los resultados. No compartas `.env`.

Las variables del entorno del proceso tienen prioridad sobre los valores de `.env`. El lanzador busca el ejecutable `k6` en el PATH; si está en otra ubicación, define su ruta mediante `K6_BIN`.

Antes de ejecutar, revisa `config/environment.json`: la URL, la gestión, el mes, la entidad y la oficina deben corresponder al ambiente habilitado. Para cloud, `cloud.loadZone` conserva la región acordada `amazon:us:ashburn` y queda registrada en la configuración efectiva. El flujo valida el contexto activo y no lo cambia para forzar la prueba. Los datos de `data/vouchers.json` solo deben ajustarse después de verificarlos con el grupo.

## Estructura del proyecto

```text
dip-cat-v-final/
├── config/                     Configuración del ambiente y de las pruebas
│   ├── tests.json              Los seis tests: VUs, etapas, pausas, tipos y thresholds
│   ├── environment.json        URL, contexto, timeout, sesión y zona cloud
│   └── test-config.js          Validación de los tests y construcción del escenario k6
├── data/                       Datos que se utilizan para completar los comprobantes
│   └── vouchers.json           Cuentas e importes de los cuatro tipos
├── src/                        Código ejecutado por k6
│   ├── main.js                 Selección del tipo por iteración y registro del resultado
│   ├── config.js               Carga de configuración y variables de entorno
│   ├── session-policy.js       Estrategias per-iteration, per-vu y shared
│   ├── session-cookies.js      Transferencia segura de cookies al cookie jar de k6
│   ├── session-summary.js      Exclusión de setup_data de los resúmenes locales
│   ├── voucher-flow.js         Flujo contable con una sesión ya autenticada
│   ├── workflow.js             Autenticación y consulta del contexto contable
│   ├── voucher-requests.js     Preparación, guardado y verificación del comprobante
│   ├── http-client.js          Peticiones HTTP con timeout y etiquetas de operación
│   ├── voucher-parse.js        Extracción y comparación de datos de las respuestas
│   └── metrics.js              Métricas de tiempos, éxito y fallos del flujo
├── tests/                      Pruebas offline de flujo, sesiones, parsers y lanzador
├── docs/                       Documentación complementaria de la implementación
├── results/                    Resultados generados localmente; no se publican en Git
│   └── <runId>/                Carpeta exclusiva de una ejecución
├── run.js                      Lanzador Node.js: argumentos, ejecución y archivos de salida
├── package.json                Comandos npm del proyecto
├── package-lock.json           Información reproducible de instalación para npm
├── .env.example                Variables que debe completar cada integrante
├── .env                        Credenciales locales; no se publica en Git
├── .gitignore                  Exclusiones de archivos locales y resultados
└── README.md                   Instalación, configuración y uso del proyecto
```

`.env` se crea durante la instalación y las carpetas de cada ejecución se generan al lanzar un test. No contienen evidencias de otros integrantes al clonar el repositorio.

Para cambiar VUs, etapas, duración, pausas, tipos o thresholds de un test existente, modifica únicamente su entrada en `config/tests.json`. El lanzador y el script consumen esa misma configuración.

## Flujos

Se evalúa el registro de un comprobante contable completo, desde una sesión autenticada hasta la consulta de sus datos y la descarga del documento. Cada iteración representa un intento de crear un comprobante y usa la sesión según la política configurada:

1. Usar una sesión autenticada en la preparación, al iniciar el VU o para esta iteración, según la política seleccionada.
2. Acceder a Contabilidad, comprobar gestión, mes, entidad y oficina activos, consultar el listado y abrir el formulario.
3. Obtener del formulario el correlativo propuesto y una fecha permitida para el tipo elegido.
4. Buscar las cuentas y completar dos líneas con importes balanceados.
5. Guardar y extraer el ID interno que devuelve el servidor.
6. Consultar el registro para comparar tipo, fecha, glosas, cuentas, líneas e importes y recuperar el correlativo final.
7. Descargar el PDF y comprobar el estado de respuesta, el tipo de archivo y su firma.

### Autenticación y sesiones

La política se selecciona en `config/environment.json` mediante `sessionPolicy` y acepta `per-iteration`, `per-vu` o `shared`. La política elegida para el proyecto es `shared`, respaldada por las corridas compartidas de 10 VUs (20 registros verificados) y 50 VUs (100 registros verificados) en Grafana Cloud. La carpeta hermana `../evidencia-sesion-compartida/` está fuera de este checkout y conserva resultados y límites de esas ejecuciones.

- `per-iteration`: crea y autentica una sesión para cada comprobante.
- `per-vu`: cada usuario virtual autentica al comenzar y conserva su propia sesión entre iteraciones.
- `shared`: autentica una vez durante la preparación y cada VU instala en su cookie jar una copia de la misma identidad de sesión del servidor.

Una **cuenta** es la identidad y credencial configurada para entrar; una **sesión** es el estado autenticado que el servidor reconoce mediante cookies; un **VU** es un usuario virtual de k6 con su propio entorno de ejecución y cookie jar. Compartir sesión no significa compartir el mismo objeto de cookies entre VUs. La evidencia permite adoptar `shared` en este proyecto, pero no demuestra estabilidad prolongada, cargas superiores a 50 VUs ni que el servidor gestione cada solicitud simultáneamente.

Las peticiones HTTP generales incluyen las autenticaciones. `voucher_flow_duration` empieza cuando la política ya entregó una sesión autenticada y termina con las comprobaciones del flujo; excluye tanto el login como la pausa entre iteraciones. Por eso, los valores históricos de esa métrica que incluían autenticación no son directamente comparables con los actuales.

Si una respuesta confirma que la sesión se perdió (HTTP 401, redirección a login o formulario de contraseña), el intento se registra como fallido; no se reautentica en medio del guardado. `per-vu` puede autenticar de nuevo en una iteración posterior. `shared` registra la pérdida de la sesión preparada sin iniciar logins individuales por VU. Un estado HTTP que no permita confirmar pérdida no se presenta como diagnóstico de sesión.

Se utiliza k6 HTTP: las acciones se reproducen mediante peticiones al servidor. El recorrido incluye consultar el listado y abrir el formulario antes de preparar el comprobante. No se controla la interfaz del navegador ni se ejecuta el JavaScript recibido en las respuestas; las consultas posteriores al guardado se realizan explícitamente.

Las plantillas iniciales son balanceadas por 10 y no incluyen facturas, auxiliares ni libretas:

- Ingreso (1) e Ingreso NR (4): CAJA M/N, Debe 10; OTROS INGRESOS, Haber 10.
- Egreso (2): GASTO EN IMPRENTA, Debe 10; CAJA M/N, Haber 10.
- Traspaso (3): CAJA M/N, Debe 10; GASTO EN IMPRENTA, Haber 10.

Ingreso NR conserva su tipo propio. La excepción de libreta bancaria requiere validación aparte cuando se amplíe el alcance de los datos.

### Convenciones

#### Identificador de ejecución: runId

El `runId` relaciona una ejecución con su configuración, archivos de resultados y comprobantes. Se genera uno nuevo cada vez que se invoca el lanzador; no identifica un comprobante individual ni indica que la prueba haya aprobado.

El formato automático es `YYMMDDHHmm` seguido de seis caracteres hexadecimales aleatorios. La fecha y hora se expresan en UTC y tienen precisión de minutos. Por ejemplo, el identificador ilustrativo `2611221800a1b2c3` se interpreta así:

| Parte | Significado |
|---|---|
| `26` | Año 2026 |
| `11` | Mes de noviembre |
| `22` | Día del mes |
| `18` | Hora UTC |
| `00` | Minuto |
| `a1b2c3` | Sufijo aleatorio para distinguir ejecuciones iniciadas en el mismo minuto |

No debe confundirse con el identificador que Grafana asigna a su ejecución remota. Si se proporciona un valor manual con `--run-id`, debe ser alfanumérico, tener como máximo 16 caracteres y no corresponder a resultados locales existentes; su contenido no tiene que representar una fecha.

#### Glosa del comprobante

Las glosas siguen el formato:

```text
DIP_Cato-G6-<runId>-<escenario>-V<VU>-I<iteración>
```

Ejemplo ilustrativo: `DIP_Cato-G6-2611221800a1b2c3-CV-V2-I1`.

| Parte | Significado |
|---|---|
| `DIP_Cato-G6` | Prefijo del trabajo del Grupo 6 |
| `2611221800a1b2c3` | runId de la ejecución |
| `CV` | Código del test de concurrencia |
| `V2` | Identificador global del usuario virtual en k6 |
| `I1` | Primera iteración de ese VU en el escenario |

Los códigos son `SM` para smoke, `CV` para concurrencia, `BL` para línea base, `SU` para carga sostenida, `SP` para spike y `ST` para estrés. No representan el tipo contable; este se registra por separado en el manifiesto.

La misma glosa se envía en cabecera y líneas de detalle para comprobar que los datos pertenecen al mismo intento. El proyecto aplica un límite preventivo de 44 caracteres; no representa un máximo declarado por el sistema. La glosa no se usa como etiqueta de métrica.

#### Identificadores del comprobante

El ID interno identifica el registro guardado y se utiliza para consultarlo. El correlativo corresponde a su numeración contable. El manifiesto diferencia el correlativo propuesto antes del guardado y el correlativo final leído de la persistencia; el servidor puede asignar un número final distinto. Ninguno de estos valores sustituye al runId.

## Tipos de test

Un VU es un usuario virtual. Las iteraciones indican cuántas veces recorre el flujo; no equivalen a la cantidad de peticiones HTTP. Los seis tests se configuran en `config/tests.json`:

| Test | Para qué sirve | Configuración inicial |
|---|---|---|
| `smoke` | Comprobar que el flujo y sus validaciones funcionan antes de aumentar la carga. | 1 VU y 4 iteraciones: una por tipo contable. |
| `concurrency-validation` | Comprobar el registro simultáneo, las sesiones y la consistencia de los datos. | 2 VUs y 4 iteraciones por VU: 8 intentos en total. |
| `baseline` | Obtener una referencia de tiempos con concurrencia mínima. | 1 VU durante 5 minutos. |
| `sustained` | Observar estabilidad mientras se mantiene una carga nominal. | Subida gradual hasta 10 VUs, permanencia de 10 minutos y bajada a 0. |
| `spike` | Observar la respuesta a un incremento de usuarios y su reducción posterior. | Subida a 5 VUs, aumento a 20, permanencia en 20 y bajada a 5. |
| `stress` | Buscar degradación al aumentar progresivamente la concurrencia. | Subidas y permanencias en 5, 10, 20, 30 y 40 VUs, con bajada final a 0. |

Los tiempos exactos, las pausas y los criterios aplicados se leen del JSON. En smoke y concurrencia, `iterationsPerVu` es una cantidad por usuario: el total esperado es `vus × iterationsPerVu`. En los tests por duración, la cantidad de comprobantes dependerá de los tiempos de respuesta y de las pausas. Cada VU alterna los tipos en el orden de `types`.

Cada test define sus criterios de aprobación en `thresholds`. La configuración inicial utiliza criterios de integridad del flujo y no establece umbrales de latencia. Antes de una prueba formal, acuerda los objetivos de rendimiento y actualiza los valores en `config/tests.json`.

## Cómo ejecutar los tests

Ejecuta los comandos desde la raíz del repositorio, después de instalar las dependencias y completar `.env`.

| Modalidad | Dónde se genera la carga | Dónde se consultan las métricas |
|---|---|---|
| Local | En el equipo que ejecuta el comando. | Terminal y resumen local. |
| Híbrida | En el equipo que ejecuta el comando. | Terminal, resumen local y Grafana Cloud. |
| Cloud | En los generadores de Grafana Cloud. | Grafana Cloud. |

### Ejecución local

```powershell
npm run test:local -- --test smoke
npm run test:local -- --test concurrency-validation
```

### Ejecución híbrida

Requiere las variables de Grafana Cloud además del acceso al sistema:

```powershell
npm run test:hybrid -- --test smoke
```

### Ejecución cloud

El comando envía el proyecto a Grafana para que ejecute el test con sus recursos y muestra el enlace de la corrida:

```powershell
npm run test:cloud -- --test smoke
```

### Selección y configuración del test

Sustituye `smoke` por `concurrency-validation`, `baseline`, `sustained`, `spike` o `stress`. Por ejemplo, `npm run test:local -- --test baseline` ejecuta la línea base localmente. La modalidad y el test son decisiones independientes: no requieren scripts distintos.

Para modificar una prueba, edita su entrada en `config/tests.json`. Revisa VUs, duración o etapas, pausas, tipos y thresholds antes de lanzarla: cada iteración intenta registrar un comprobante nuevo.

`--run-id <valor>` permite asignar un identificador manual. El lanzador rechaza una carpeta de resultados ya existente en vez de sobrescribirla.

## Resultados locales

El lanzador muestra el `runId` al comenzar y crea una carpeta exclusiva `results/<runId>/`. Los resultados se generan en el equipo de quien ejecuta la prueba y no se incluyen al clonar el repositorio.

- `effective-config.json`: test, modalidad y configuración utilizada, sin credenciales.
- `console.log`: salida de k6 y eventos de los intentos.
- `manifest.ndjson`: registros de los intentos, con glosa, tipo, VU, iteración, ID interno, correlativos y estado de verificación.
- `summary.json`: resumen estadístico cuando k6 lo genera localmente.

El resumen local/híbrido omite `setup_data`, que puede contener la sesión serializada. En cloud, k6 conserva las estadísticas en Grafana y no se genera un resumen local. Las cookies no se imprimen en consola ni se guardan en los archivos de resultados.

En modalidad cloud, el manifiesto local depende de los eventos recibidos en consola. Si el resumen o los eventos no están disponibles localmente, el lanzador genera un archivo de estado que explica la ausencia. La carpeta local no sustituye la exportación de métricas remotas.

El manifiesto distingue los intentos verificados, los fallos previos al guardado y los registros cuyo guardado o verificación no pudo confirmarse. El flujo no reintenta automáticamente los guardados ambiguos; antes de repetirlos, revisa si el comprobante ya existe.

## Descarga manual de resultados de Grafana Cloud

El proyecto no descarga automáticamente el ZIP o los CSV de Grafana Cloud. En modalidad cloud, el resumen estadístico se consulta en Grafana; el lanzador conserva localmente la configuración, la consola y los eventos recibidos. En híbrida sí se genera un resumen local, pero la exportación de métricas almacenadas en Grafana también es manual.

Para descargar las métricas:

1. Abre el enlace de ejecución que aparece en la terminal y espera a que finalice.
2. En la página de resultados, abre el menú de tres puntos de la esquina superior derecha.
3. Selecciona **Export data** y confirma la exportación.
4. Cuando esté lista, selecciona **Download**. Si ya se exportó, utiliza **Download export data** en el mismo menú.
5. Guarda el ZIP dentro de `results/<runId>/`, por ejemplo con el nombre `cloud-export.zip`, para asociarlo con la configuración y el manifiesto correctos.

El ZIP incluye varios CSV, separados por métrica. Las descargas y las capturas necesarias para el informe deben conservarse como evidencias de la ejecución; no se incluyen en Git. Los percentiles de diferentes filas o intervalos no deben promediarse para obtener un percentil global.

Consulta el procedimiento en la [documentación de exportación de Grafana Cloud k6](https://grafana.com/docs/grafana-cloud/observe-and-act/testing/k6/analyze-results/export-results/).

## Validaciones

El flujo comprueba autenticación, contexto activo, cuentas, cantidad de líneas, fecha, glosas, importes, totales y correlativo final. La validación del PDF comprueba estado HTTP, `Content-Type` y firma `%PDF`; no interpreta el texto ni el diseño del documento.

Los checks describen las comprobaciones de cada operación y los thresholds determinan la aprobación de la ejecución. El lanzador conserva el código de salida de k6. Revisa el resumen y el manifiesto para identificar el motivo de un fallo.

## Pruebas del proyecto

Las pruebas automatizadas de parsers, configuración y lanzador se ejecutan sin conectarse al sistema:

```powershell
npm test
```

La suite verifica parsers, configuración, los tres perfiles de sesión, cookies entre iteraciones con un servidor local de prueba y el lanzamiento. Incluye verificaciones de asignación para 5 y 10 VUs. No envía peticiones al ambiente financiero, no crea comprobantes y no sustituye las pruebas reales autorizadas.
