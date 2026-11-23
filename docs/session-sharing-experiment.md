# Experimento de sesiones compartidas en k6

## Objetivo y alcance

Comparar dos condiciones con la misma carga pequeña para observar el comportamiento del flujo cuando dos VUs usan una única sesión autenticada o sesiones independientes. La prueba se ejecutó en modo local, sin Grafana Cloud. No se modificó la política predeterminada de sesión (`per-iteration`).

Cada condición usa 2 VUs y 2 iteraciones por VU (4 iteraciones totales), sin ramp-up. Cada VU procesa los tipos 3 y 1, en ese orden. Hay una pausa de 3 segundos entre iteraciones. El máximo es de 4 comprobantes por condición y 8 en las dos condiciones combinadas. La creación no tiene reintentos automáticos.

El comando es `npm run experiment:session -- --condition shared` o `npm run experiment:session -- --condition independent` desde la raíz del repositorio. El runner necesita `FINANCIERO_USER`, `FINANCIERO_PASSWORD` y `FINANCIERO_BASE_URL` en `.env`.

## Validación de cuentas persistidas

El parser identifica la fila a partir de `filaActiva` y valida el ID de cuenta en el primer argumento de `setBusquedaCuentaEdit`. La firma comprobada en la respuesta de edición y en la grabación sanitizada es `setBusquedaCuentaEdit(codigoCuenta, numeroCuenta, nombreCuenta, codigoCuentaAux, nombreCuentaAux)`. La función usa `codigoCuenta` para escribir `cuenta${fila}` y `codigoCuentaAux` para `cuenta_auxiliar${fila}`. Por eso el ID auxiliar o cualquier otro número de la llamada no puede satisfacer la comparación de la cuenta.

La respuesta editable real contiene, por ejemplo, `filaActiva=1; setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','0','')`; la segunda línea cambia a `filaActiva=2` antes de su llamada. La función usa `var fila=filaActiva`, asigna `codigoCuenta` a `cuenta${fila}` y `codigoCuentaAux` a `cuenta_auxiliar${fila}`. La firma y la asignación a fila también se confirmaron en el JavaScript sanitizado de la grabación. La validación compara ID, número y nombre esperados para esa fila. Rechaza filas ausentes, duplicadas o con una firma no reconocida, sin depender solo del orden de las llamadas. Las comprobaciones existentes de glosas, importes y totales siguen activas.

## Resultados

| Condición | RUN_ID | Autenticaciones setup | Sesiones server-side | Iteraciones | Registros creados y verificados | Guardados solapados |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Compartida (`SC`) | `261123013055c50c` | 1 | Iguales | 4/4 | 4/4 | No |
| Independiente (`SI`) | `2611230137d01ad9` | 2 | Distintas | 4/4 | 4/4 | No |

En ambas condiciones, todos los checks y thresholds del flujo aprobaron. No hubo fallos HTTP ni cambios de identidad de sesión durante las iteraciones. La verificación posterior encontró persistidos los cuatro registros de cada condición y comprobó sus PDFs.

La revisión posterior de solo lectura terminó con **8/8 registros verificados**, sin discrepancias respecto a los manifiestos originales. En los cuatro registros de tipo 3, las filas fueron Caja M/N (ID 13004) y Gasto en Imprenta (ID 13291). En los cuatro registros de tipo 1, fueron Caja M/N (ID 13004) y Otros Ingresos (ID 13195). En los ocho registros coincidieron tipo, fecha `2026-09-01`, glosa de cabecera y de detalle, importes `10.00/0.00` y `0.00/10.00`, totales `10.00/10.00` y correlativo final. El PDF de cada registro devolvió HTTP 200, `application/pdf` y firma `%PDF`. No se creó ni editó ningún comprobante.

Los registros fueron:

| Condición | Tipo | VU / iteración | ID | Correlativo final |
| --- | ---: | --- | ---: | ---: |
| Compartida | 3 | VU2 / I1 | 18414 | 5325 |
| Compartida | 3 | VU1 / I1 | 18415 | 5326 |
| Compartida | 1 | VU2 / I2 | 18416 | 23 |
| Compartida | 1 | VU1 / I2 | 18417 | 24 |
| Independiente | 3 | VU2 / I1 | 18422 | 5329 |
| Independiente | 3 | VU1 / I1 | 18423 | 5330 |
| Independiente | 1 | VU1 / I2 | 18424 | 27 |
| Independiente | 1 | VU2 / I2 | 18425 | 28 |

Los cuatro guardados de cada condición ocurrieron en intervalos distintos. Por tanto, este experimento confirma la separación de sesiones y que ambos modos completaron el flujo en estas corridas; **no demuestra que dos solicitudes de guardado concurrentes compitan por el correlativo**. No se observaron IDs ni correlativos finales duplicados. Las diferencias de correlativos entre condiciones también pueden deberse a la actividad del sistema y a que los tipos usan series distintas.

## Manejo de resúmenes y límites

Los scripts del experimento usan `handleSummary()` para quitar `setup_data` del objeto antes de que k6 escriba el resumen. No usan `--summary-export` ni saneamiento posterior. Las estadísticas y thresholds se conservan. Una prueba offline de k6 2.3.0 coloca una cookie ficticia en los datos de setup, genera un resumen real y examina los archivos escritos para confirmar que el sentinel no queda persistido. El [manual de resúmenes personalizados de k6](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/) describe este mecanismo.

El manifiesto, la configuración efectiva, el resumen y la verificación posterior se guardan localmente bajo `results/<RUN_ID>/`, una carpeta ignorada por Git. La revisión de los registros originales quedó en una carpeta `results/reviews/post-original-session-review-*`, también local e ignorada por Git. Este documento incluye el diseño, los resultados y las limitaciones necesarios para entender el experimento sin esos archivos locales.

Estas corridas no representan una carga de 100 o 500 VUs. Tampoco prueban que compartir una sesión nunca produzca interferencias. No se cambió la política predeterminada (`per-iteration`).

Una invocación previa de la condición independiente no inició autenticación porque el entorno aislado no resolvió el host; no produjo comprobantes. La ejecución válida posterior se completó con acceso de red autorizado.

## Conclusión acotada

El flujo completó cuatro comprobantes con una cookie de sesión compartida y otros cuatro con cookies independientes. No hubo errores de negocio, persistencia o descarga del PDF. Como los POST de guardado no se solaparon, no hay evidencia en estas corridas de una carrera sobre correlativos; se necesitaría una condición que provoque o mida solapamiento para evaluar ese caso. Este resultado no justifica cambiar la política predeterminada de sesiones ni permite extrapolar a cargas mayores.

## Siguiente prueba propuesta

Si se autoriza otra consulta con altas, realizar una sola corrida local con 2 VUs, 1 iteración por VU y el mismo tipo/contexto. Usar una barrera justo antes del POST para intentar solapar exactamente dos guardados, con máximo 2 comprobantes nuevos y sin reintentos. Confirmar primero autenticación y configuración; luego comparar intervalos, IDs, correlativos y persistencia. Si los intervalos no se solapan, registrar el intento como inconcluso y no aumentar la carga automáticamente.
