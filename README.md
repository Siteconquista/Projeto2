# Loop — Lembrete de Clientes (com contas e envio automático)

Cada pessoa cria a própria conta com e-mail e senha e só vê os próprios clientes.
Todo dia às 9h (horário da Bahia) o servidor envia os lembretes pelo WhatsApp de cada conta (Z-API).
O link da API é colocado dentro do site, no botão "API WhatsApp".

## Variáveis de ambiente
- DATA_FILE  -> /data/data.json  (disco/volume persistente: guarda contas e clientes)
- SEND_HOUR  -> opcional, hora do envio (padrão 9)

## Hospedar (exemplo: Railway)
1. Suba esta pasta para um repositório no GitHub.
2. railway.app > New Project > Deploy from GitHub repo.
3. Em Variables, cadastre DATA_FILE=/data/data.json
4. Em Volumes, crie um volume montado em /data (sem isso os dados se perdem a cada deploy).
5. Em Settings > Networking, gere o domínio público. Esse é o link do site.

## Segurança
Senhas guardadas com hash (scrypt), nunca em texto. Login bloqueia após 5 erros por 10 minutos.
O arquivo de dados tem cópia automática (data.json.bak) a cada gravação.
