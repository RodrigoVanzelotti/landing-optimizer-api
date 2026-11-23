# Exclusão permanente de sites

`DELETE /sites/:id` exige administrador atual do workspace e corpo JSON
`{ "confirmation": "dominio.exato" }`. A comparação usa o domínio registrado
(incluindo porta, se houver), após remover espaços externos. Editores, leitores
e o perfil legado `owner` não recebem essa permissão. Uma repetição após exclusão
concluída retorna 204 sem duplicar auditoria.

A exclusão remove o site e suas credenciais, origens, metas, insights, experimentos,
variantes, mudanças, aprovações, resultados, diretrizes, mapas e imagens capturadas.
Remove eventos PostgreSQL, eventos e os três agregados ClickHouse quando esse
backend é utilizado, e o cache assinado Redis. Favoritos são anulados pelo banco.
Credenciais do site deixam de autenticar coleta/configuração; sessões de usuário
continuam sendo da conta. O cliente deve remover o snippet do seu site público.

Por decisão de negócio aprovada pelo usuário, o histórico relacionado ao site é
apagado e somente `site.deleted` permanece: administrador responsável, data e ID,
sem domínio, conteúdo, métricas ou hash de IP. Outros sites e contas são preservados.

A migração `20261123120000_site_suggestion_cascade` acrescenta a relação de insights
com exclusão em cascata. `NOT VALID` protege novas gravações e sites existentes
sem apagar nem impedir o deploy por eventuais órfãos históricos; estes precisam
de saneamento e validação da constraint em manutenção própria.

O bloqueio exclusivo do site serializa exclusão com publicação e ingestão
ClickHouse. A ingestão mantém bloqueio compartilhado até o flush; a publicação e
reconstrução do cache escrevem antes de liberar o bloqueio. FKs impedem recriação
de registros relacionais após exclusão. Mutações ClickHouse aguardam conclusão em
todos os réplicas (`mutations_sync=2`), incluindo os agregados com armazenamento próprio.
Referências: [inserção assíncrona](https://clickhouse.com/blog/asynchronous-data-inserts-in-clickhouse)
e [encaminhamento de mutações de views](https://github.com/ClickHouse/ClickHouse/blob/master/src/Storages/StorageMaterializedView.cpp).

PostgreSQL, ClickHouse e Redis não compartilham uma transação distribuída.
Falhas externas ou no commit nunca retornam sucesso e podem deixar uma limpeza
parcial; a interface pede atualizar e permite repetir a operação. Nenhuma fila
ou rotina automática de exclusão foi adicionada. Backups, logs operacionais e
contadores temporários de proteção seguem a retenção da infraestrutura.
