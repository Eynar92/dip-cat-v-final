# Evaluación de comprobantes con k6

Este repositorio contiene una prueba funcional de bajo volumen para el flujo de creación de comprobantes de Financiero de MinkaSoftware. Recorre autenticación, contexto contable, formulario, búsqueda de cuentas, guardado, consulta de persistencia y descarga del PDF. Los perfiles se preparan para futuras mediciones; las pruebas de carga todavía requieren un protocolo aprobado y una línea base.

## Requisitos e instalación

- Node.js y npm compatibles con `package.json`.
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
```

El usuario y la contraseña son obligatorios en todas las modalidades. El token y el stack solo son necesarios para híbrida y cloud. Los secretos no se versionan ni se imprimen en los resultados. No compartas `.env`.

Antes de ejecutar, revisa `config/environment.json`: la URL, la gestión, el mes, la entidad y la oficina deben corresponder al ambiente habilitado. El flujo valida el contexto activo y no lo cambia para forzar la prueba. Los datos de `data/vouchers.json` solo deben ajustarse después de verificarlos con el grupo.

## Estructura

- `config/tests.json`: configuración de los seis tests, incluidos executor, tipos, VUs, iteraciones o etapas, pausas y thresholds.
- `config/environment.json`: URL, contexto esperado, timeout de solicitudes y política de sesión.
- `data/vouchers.json`: plantillas contables compartidas para los cuatro tipos.
- `src/`: entrada k6, flujo de negocio, acceso HTTP, parsers y métricas.
- `run.js` y `package.json`: selección de modalidad/test y lanzamiento de k6.
- `docs/`: trazabilidad y decisiones de la implementación.
- `results/<runId>/`: evidencias locales de cada invocación; se excluyen de Git.

Para cambiar VUs, etapas, duración, pausas, tipos o thresholds de un test existente, modifica únicamente su entrada en `config/tests.json`. El lanzador y el script consumen esa misma configuración.

## Flujos

Cada iteración realiza una autenticación nueva por defecto y usa su propio almacén de cookies durante el flujo. La política se declara en `config/environment.json`; no se reutiliza una sesión entre iteraciones salvo que se configure y verifique expresamente otra política.

El recorrido comprueba el acceso, selecciona Contabilidad, valida el contexto activo, lee el formulario, solicita correlativo y fecha, abre las líneas, busca cada cuenta por número y obtiene su ID exacto. Después envía el formulario multipart, extrae el ID interno, consulta el registro persistido y solicita el PDF. k6 no ejecuta el JavaScript devuelto por el servidor, así que las consultas posteriores se hacen explícitamente.

Las plantillas iniciales son balanceadas por 10 y no incluyen facturas, auxiliares ni libretas:

- Ingreso (1) e Ingreso NR (4): CAJA M/N, Debe 10; OTROS INGRESOS, Haber 10.
- Egreso (2): GASTO EN IMPRENTA, Debe 10; CAJA M/N, Haber 10.
- Traspaso (3): CAJA M/N, Debe 10; GASTO EN IMPRENTA, Haber 10.

Ingreso NR conserva su tipo propio. La excepción de libreta bancaria requiere validación aparte cuando se amplíe el alcance de los datos.

### Convenciones

Las glosas comienzan con `DIP_Cato-G6-` y siguen el formato:

```text
DIP_Cato-G6-<runId>-<escenario>-V<VU>-I<iteración>
```

Por ejemplo, `DIP_Cato-G6-<runId>-CV-V2-I1` identifica la primera iteración del segundo VU en el escenario de concurrencia. El `runId` es nuevo por invocación; el código corto identifica el test (`SM`, `CV`, `BL`, `SU`, `SP` o `ST`). La misma glosa se envía en cabecera y líneas de detalle. Se limita a los 44 caracteres aceptados en las ejecuciones observadas y no se usa como etiqueta de métrica.

El manifiesto diferencia el correlativo propuesto antes del guardado y el correlativo final leído de la persistencia. El servidor puede asignar un número final distinto; ambas etapas quedan trazadas por separado.

## Tests y ejecución

Los seis tests se configuran en `config/tests.json`:

- `smoke`: un VU y cuatro iteraciones, una por tipo.
- `concurrency-validation`: dos VUs y cuatro iteraciones por VU; cada VU recorre los cuatro tipos.
- `baseline`: un VU durante cinco minutos, como propuesta inicial.
- `sustained`: etapas de subida y permanencia según el modelo provisional del grupo.
- `spike`: subida hasta 20 VUs, permanencia en el pico y recuperación hasta 5 VUs; las duraciones se definen en el JSON.
- `stress`: escalones provisionales hasta 40 VUs.

Los perfiles de carga no son metas de rendimiento aprobadas. No se han fijado thresholds de latencia; deberán acordarse después de medir una línea base y revisar las condiciones del ambiente compartido.

Ejecuta localmente:

```powershell
npm run test:local -- --test smoke
npm run test:local -- --test concurrency-validation
```

Las modalidades híbrida y cloud quedan preparadas así; requieren configuración de Grafana Cloud:

```powershell
npm run test:hybrid -- --test baseline
npm run test:cloud -- --test baseline
```

El lanzador informa el `runId` y la carpeta exclusiva `results/<runId>/`. Ahí conserva el resumen, el log, el manifiesto y la configuración efectiva sin secretos. Para cloud, el generador remoto puede no dejar todos los archivos localmente; consulta la ejecución y sus límites de exportación en Grafana Cloud. No se añade almacenamiento remoto adicional.

`--run-id <valor>` permite asignar un identificador manual. El lanzador rechaza una carpeta de resultados ya existente en vez de sobrescribirla.

## Verificación y estado

Las pruebas automatizadas de parsers, configuración y lanzador se ejecutan sin conectarse al sistema:

```powershell
npm test
```

Antes del refactor se completaron un smoke local y una validación pequeña de concurrencia. El smoke fue de un VU con cuatro tipos; la ejecución informada tuvo 68/68 checks aprobados, 4/4 flujos de negocio exitosos y ningún fallo HTTP. La concurrencia fue de dos VUs, cuatro iteraciones por VU y ocho comprobantes; tuvo 136/136 checks aprobados, 8/8 flujos exitosos y ningún fallo HTTP. Estas evidencias son históricas y no se generaron con el código refactorizado.

En la ejecución de concurrencia, las sesiones solicitaron algunos correlativos propuestos iguales; al consultar la persistencia, los correlativos finales mostrados por la interfaz fueron distintos. La repetición de los valores propuestos no debe describirse como duplicación de los números finales. El manifiesto histórico combinó filas del smoke y de concurrencia porque se reutilizó el `runId`; el nuevo lanzador crea un identificador y una carpeta separados por invocación.

La verificación offline del refactor pasó: `npm test` terminó con 32/32 pruebas aprobadas y `k6 inspect` aceptó los seis perfiles con k6 v2.3.0.

La verificación integrada local del refactor se ejecutó el 22/11/2026:

| Test | Run ID | Resultado |
|---|---|---|
| Smoke | `2611221853dc51be` | 4/4 comprobantes verificados, 88/88 checks aprobados y 0/68 solicitudes HTTP fallidas. IDs: 18382, 18383, 18384 y 18385. |
| Concurrencia mínima | `26112218540b8fd0` | 8/8 iteraciones completas, 5/8 comprobantes verificados, 170/173 checks aprobados y 0/133 solicitudes HTTP fallidas. Los thresholds de éxito de negocio fallaron. |

La concurrencia produjo dos resultados que requieren revisión del supervisor. En el tipo Ingreso, ambas iteraciones reportaron el ID interno 18386 y el correlativo final 17; la consulta de solo lectura encontró la glosa de cabecera del VU 1 y las glosas de detalle del VU 2 en el mismo registro. En Traspaso, el ID 18389 tenía solo una línea y totales Debe 10, Haber 0 y diferencia 10; el registro concurrente 18390 sí pasó la verificación. Los correlativos finales variaron entre tipos: algunos pares fueron distintos y otros iguales. La repetición del valor propuesto, por sí sola, no prueba un error; el ID repetido y los datos persistidos mezclados sí son hallazgos observados en esta ejecución.

El archivo de consola de concurrencia conserva los ocho eventos del manifiesto. `manifest.ndjson` quedó vacío porque el lanzador no interpretó el formato de log emitido por k6 v2.3.0; el extractor ya está corregido y cubierto por pruebas, pero no se reescribió esa evidencia. En una nueva ejecución el manifiesto debe quedar separado bajo la carpeta del `runId`.

No se ejecutaron pruebas híbridas, cloud, línea base, carga sostenida, spike ni estrés. No se repitieron las altas de concurrencia después de detectar fallos de persistencia. El lanzador no reintenta automáticamente un POST ambiguo.

La validación del PDF comprueba estado HTTP, `Content-Type` y firma `%PDF`; no interpreta el texto ni el diseño del documento.
