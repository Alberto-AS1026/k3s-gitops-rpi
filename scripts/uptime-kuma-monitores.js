// Crea los monitores del clúster y la página de estado en Uptime Kuma (idempotente).
// Uso (ver docs/05, apartado 5.6):
//   TOKEN=$(kubectl -n uptime-kuma get secret monitor-api-token -o jsonpath='{.data.token}' | base64 -d)
//   kubectl -n uptime-kuma exec -i deploy/uptime-kuma -- node - "<contraseña de admin>" "$TOKEN" < scripts/uptime-kuma-monitores.js
// Si la primera ejecución no responde (servidor recién arrancado), repetirla: no crea duplicados.
const io = require("socket.io-client");
const [PASS, TOKEN] = process.argv.slice(2);
const s = io("http://localhost:3001", { transports: ["websocket"] });
const call = (ev, ...args) => new Promise((ok) => s.emit(ev, ...args, ok));

// Valores por defecto del formulario "Añadir monitor" (src/pages/EditMonitor.vue, v2.5.11)
const base = {
    type: "http", parent: null, method: "GET", interval: 60, retryInterval: 60, resendInterval: 0,
    maxretries: 1, notificationIDList: {}, ignoreTls: false, upsideDown: false, expiryNotification: false,
    maxredirects: 10, accepted_statuscodes: ["200-299"], dns_resolve_type: "A", dns_resolve_server: "",
    kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: "None" }, rabbitmqNodes: [],
    conditions: [], httpBodyEncoding: "json", headers: null, body: null,
};

const monitores = [
    { grupo: "Kubernetes", name: "API de Kubernetes", url: "https://kubernetes.default.svc.cluster.local/readyz",
        ignoreTls: true, headers: JSON.stringify({ Authorization: `Bearer ${TOKEN}` }) },
    { grupo: "Kubernetes", name: "DNS del clúster (CoreDNS)", type: "dns", hostname: "kubernetes.default.svc.cluster.local",
        dns_resolve_server: "10.43.0.10", port: 53 },
    { grupo: "GitOps", name: "Argo CD", url: "http://argocd-server.argocd.svc.cluster.local/healthz" },
    { grupo: "GitOps", name: "GitHub (repositorio GitOps)", url: "https://github.com/Alberto-AS1026/k3s-gitops-rpi", interval: 300 },
    { grupo: "Entrada (Traefik)", name: "Traefik → Argo CD", url: "http://traefik.kube-system.svc.cluster.local/",
        headers: JSON.stringify({ Host: "argocd.lab.home.arpa" }) },
    { grupo: "Entrada (Traefik)", name: "Traefik → Uptime Kuma", url: "http://traefik.kube-system.svc.cluster.local/",
        headers: JSON.stringify({ Host: "status.lab.home.arpa" }), maxredirects: 0, accepted_statuscodes: ["200-299", "300-399"] },
    { grupo: "Nodo", name: "SSH de la Raspberry Pi", type: "port", hostname: "192.168.0.27", port: 22 },
];

let existentes = null;
s.on("monitorList", (lista) => { existentes = lista; });

s.on("connect", async () => {
    const login = await call("login", { username: "admin", password: PASS, token: "" });
    if (!login.ok) { console.log("login fallido:", login.msg); process.exit(1); }
    while (existentes === null) await new Promise((r) => setTimeout(r, 200));

    const idPorNombre = {};
    for (const m of Object.values(existentes)) idPorNombre[m.name] = m.id;

    for (const m of monitores) {
        if (idPorNombre[m.name]) { console.log(`ya existe: ${m.name}`); continue; }
        const { grupo, ...datos } = m;
        const r = await call("add", { ...base, ...datos });
        console.log(r.ok ? `creado:    ${m.name} (id ${r.monitorID})` : `ERROR ${m.name}: ${r.msg}`);
        if (r.ok) idPorNombre[m.name] = r.monitorID;
    }

    // Página de estado pública
    const slug = "cluster";
    const nueva = await call("addStatusPage", "Estado del clúster", slug);
    if (!nueva.ok && !/already|exist|UNIQUE/i.test(nueva.msg || "")) console.log("addStatusPage:", nueva.msg);
    const grupos = [...new Set(monitores.map((m) => m.grupo))].map((g) => ({
        name: g, monitorList: monitores.filter((m) => m.grupo === g).map((m) => ({ id: idPorNombre[m.name] })),
    }));
    const config = {
        slug, title: "Estado del clúster", description: "Raspberry Pi 4 · K3s · Traefik · Argo CD (GitOps)",
        autoRefreshInterval: 60, theme: "auto", showTags: false, footerText: "github.com/Alberto-AS1026/k3s-gitops-rpi",
        customCSS: "", showPoweredBy: false, rssTitle: null, showOnlyLastHeartbeat: false, showCertificateExpiry: false,
        analyticsId: null, analyticsScriptUrl: null, analyticsType: null, domainNameList: [],
    };
    const guardada = await call("saveStatusPage", slug, config, "/icon.svg", grupos);
    console.log(guardada.ok ? `página de estado: /status/${slug}` : `ERROR página: ${guardada.msg}`);
    s.close(); process.exit(0);
});
s.on("connect_error", (e) => { console.log("error de conexión:", e.message); process.exit(1); });
setTimeout(() => { console.log("tiempo agotado"); process.exit(2); }, 60000);
