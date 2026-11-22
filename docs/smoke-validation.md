# Verificación estricta del smoke

El perfil smoke debe ejecutarse con un VU y cuatro iteraciones secuenciales, una por tipo. Las glosas de hasta 44 caracteres están admitidas por el ambiente según el smoke; el formulario no declara un límite mayor. El script conserva ese máximo observado y valida la glosa antes de iniciar solicitudes.

Cada iteración debe comprobar:

1. Login aceptado y sesión autenticada.
2. Gestión, mes, oficina, entidad y área disponibles según `config/environment.json`, sin modificarlos.
3. Correlativo y fecha devueltos por el ambiente.
4. ID interno de cada cuenta obtenido en su búsqueda y nombre esperado.
5. Balance antes del POST y respuesta de guardado con ID interno.
6. Tipo, fecha, glosa de cabecera y líneas, cuentas, importes y totales en la página persistida.
7. PDF con HTTP 200, `Content-Type: application/pdf` y firma `%PDF`.

La validación del PDF confirma descarga y formato; no interpreta el texto ni el diseño del documento.

El flujo no reintenta un guardado. Si la respuesta no permite extraer el ID, queda marcado como ambiguo y debe revisarse la persistencia por glosa antes de cualquier decisión manual. Un error posterior al guardado conserva el ID, glosa y estado en el manifiesto.

El smoke inicial se ejecutó contra el ambiente con cuatro iteraciones autorizadas. Una excepción del runtime ocurrió al iniciar la consulta persistida, después de recibir los IDs de guardado. Se corrigió la construcción de la URL en el código; no se repitió el flujo de creación para respetar el máximo de cuatro altas. Las cuatro altas se verificaron después mediante consultas autenticadas de solo lectura, incluidas persistencia exacta y PDF. El manifiesto detallado queda en `results/`, que está excluido de Git.

## Validación de concurrencia mínima

Antes del refactor también se ejecutó el perfil de concurrencia con dos VUs y cuatro iteraciones por VU. Se completaron ocho iteraciones y se crearon ocho comprobantes. El resumen informó 136/136 checks aprobados, 8/8 flujos de negocio exitosos y cero solicitudes HTTP fallidas; los ocho registros quedaron verificados.

Durante esa ejecución, las sesiones recibieron valores propuestos de correlativo iguales para algunos tipos. La consulta posterior mostró correlativos finales distintos. El valor propuesto es una respuesta previa al guardado y no se debe presentar como el número final asignado. La prueba fue acotada a dos VUs y no demuestra el comportamiento con cargas mayores.

El manifiesto de aquella evidencia contiene 16 filas porque se reutilizó el mismo `runId` en una ejecución smoke y otra de concurrencia. Las filas se distinguen por escenario (`SM` y `CV`). Esta mezcla es una limitación de la implementación histórica; el lanzador refactorizado debe crear una carpeta y un `runId` nuevos por invocación, evitando sobreescribir resultados existentes.

Estos resultados son antecedentes del código anterior al refactor. Las pruebas offline del refactor deben ejecutarse antes de decidir si es necesario repetir el smoke o la concurrencia. No se deben repetir altas automáticamente ante un fallo posterior al guardado.
