// ============================================================
// V7-A2 壳内本地代理：CORS 根治。
//
// 形态：仅监听 127.0.0.1 动态端口（bind :0，防端口冲突/防火墙弹窗面最小）。
// URL 约定：http://127.0.0.1:<port>/proxy/<scheme>/<host[:port]>/<真实路径>?<query>
//   → 剥前缀转发到 <scheme>://<host>/<真实路径>?<query>。
//   这样前端 baseURL 填 `http://127.0.0.1:<port>/proxy/https/sub2api.x/v1`
//   即可，client.ts 拼 `${base}/chat/completions` 天然成立——前端零改动。
//
// 关键点：
// - OPTIONS 预检在本地直接消化（网关常对 OPTIONS 回 403，转发必死）；
// - 所有响应补 CORS 头（Tauri 窗口源是 tauri://localhost，打 127.0.0.1 仍算跨源）；
// - 响应体逐块透传（SSE 真流式，客户端停止=连接断=上游停流）；
// - TLS 走 reqwest 默认 native-tls（Windows=Schannel），不用 rustls/ring。
// ============================================================

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::sync::OnceLock;
use tauri::Manager;
use tokio::net::TcpListener;

/// 全局端口槽：setup 里 bind 成功后写入；前端 invoke("proxy_port") 读取（0=未起）。
#[derive(Default)]
pub struct ProxyPort(pub OnceLock<u16>);

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type ProxyBody = BoxBody<Bytes, BoxError>;

const CORS_HEADERS: [(&str, &str); 4] = [
  ("access-control-allow-origin", "*"),
  ("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"),
  ("access-control-allow-headers", "*"),
  ("access-control-max-age", "600"),
];

/// 逐跳/需重算的头：转发请求与回传响应时都要剔掉
fn strip_hop_by_hop(name: &hyper::header::HeaderName) -> bool {
  const DROP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ];
  DROP.contains(&name.as_str())
}

fn full(body: impl Into<Bytes>) -> ProxyBody {
  Full::new(body.into())
    .map_err(|e: Infallible| match e {})
    .boxed()
}

fn with_cors<T>(resp: &mut Response<T>) {
  for (k, v) in CORS_HEADERS {
    resp
      .headers_mut()
      .insert(k, hyper::header::HeaderValue::from_static(v));
  }
}

/// 解析 `/proxy/<scheme>/<host>/<path…>`；不匹配返回 None
fn parse_target(uri: &hyper::Uri) -> Option<reqwest::Url> {
  let rest = uri.path().strip_prefix("/proxy/")?;
  let (scheme, after) = rest.split_once('/')?;
  if scheme != "http" && scheme != "https" {
    return None;
  }
  let (host, path) = match after.split_once('/') {
    Some((h, p)) => (h, p),
    None => (after, ""),
  };
  if host.is_empty() {
    return None;
  }
  let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
  let raw = format!("{scheme}://{host}/{path}{query}");
  reqwest::Url::parse(&raw).ok()
}

async fn handle(
  req: Request<Incoming>,
  client: &reqwest::Client,
) -> Result<Response<ProxyBody>, Infallible> {
  let (parts, body) = req.into_parts();
  let method = parts.method.clone();

  // 健康探针：tauri.conf 之外，前端探活/排障用
  if parts.uri.path() == "/health" {
    let mut resp = Response::new(full("ok"));
    with_cors(&mut resp);
    return Ok(resp);
  }

  // 预检本地消化（不回源）：sub2api 等网关对 OPTIONS 直接 403
  if method == Method::OPTIONS {
    let mut resp = Response::new(full(""));
    *resp.status_mut() = StatusCode::NO_CONTENT;
    with_cors(&mut resp);
    return Ok(resp);
  }

  let target = match parse_target(&parts.uri) {
    Some(u) => u,
    None => {
      let mut resp = Response::new(full(
        "story-studio proxy: 用法 /proxy/<http|https>/<host>/<路径>",
      ));
      *resp.status_mut() = StatusCode::NOT_FOUND;
      with_cors(&mut resp);
      return Ok(resp);
    }
  };

  // 请求体全量读入（chat 请求都是 KB 级 JSON，流式只发生在响应侧）
  let bytes = match BodyExt::collect(body).await {
    Ok(c) => c.to_bytes(),
    Err(e) => {
      let mut resp = Response::new(full(format!("读取请求体失败：{e}")));
      *resp.status_mut() = StatusCode::BAD_REQUEST;
      with_cors(&mut resp);
      return Ok(resp);
    }
  };

  // 转头部：剔逐跳 + host/content-length/accept-encoding（reqwest 自管、且自动解压）
  let mut fwd_headers = hyper::HeaderMap::new();
  for (k, v) in parts.headers.iter() {
    if strip_hop_by_hop(k) {
      continue;
    }
    match k.as_str() {
      "host" | "content-length" | "accept-encoding" => continue,
      _ => {
        fwd_headers.insert(k.clone(), v.clone());
      }
    }
  }

  let m = reqwest::Method::from_bytes(method.as_str().as_bytes())
    .unwrap_or(reqwest::Method::POST);
  let mut rb = client.request(m, target).headers(fwd_headers);
  if !bytes.is_empty() {
    rb = rb.body(bytes);
  }

  let upstream = match rb.send().await {
    Ok(r) => r,
    Err(e) => {
      // 上游不可达/证书错等：如实带出（设置页「测试」直接显示这条）
      let mut resp = Response::new(full(format!("代理转发失败：{e}")));
      *resp.status_mut() = StatusCode::BAD_GATEWAY;
      with_cors(&mut resp);
      return Ok(resp);
    }
  };

  let status = StatusCode::from_u16(upstream.status().as_u16())
    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
  let mut resp = Response::new(ProxyBody::default());
  *resp.status_mut() = status;

  // 回传头部：剔逐跳 + content-length/content-encoding（reqwest 已解压重编）
  for (k, v) in upstream.headers().iter() {
    if strip_hop_by_hop(k) {
      continue;
    }
    match k.as_str() {
      "content-length" | "content-encoding" => continue,
      _ => {
        resp.headers_mut().insert(k.clone(), v.clone());
      }
    }
  }
  with_cors(&mut resp);

  // 响应体逐块透传：SSE 真流式；客户端中断 → 连接关闭 → 上游停流
  let stream = upstream.bytes_stream().map(|chunk| {
    chunk
      .map(|b| Frame::data(b))
      .map_err(|e| -> BoxError { Box::new(e) })
  });
  // 显式 BodyExt::boxed——StreamExt::boxed 在作用域里，方法语法会歧义（E0034）
  *resp.body_mut() = BodyExt::boxed(StreamBody::new(stream));
  Ok(resp)
}

/// 启动代理（setup 里 spawn）。绑定失败=静默降级：proxy_port 返回 0，
/// 前端按「代理不可用」处理（直连仍可能对支持 CORS 的官方 API 有效）。
pub async fn start(app: tauri::AppHandle) {
  let state = app.state::<ProxyPort>();
  let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
    Ok(l) => l,
    Err(e) => {
      log::error!("local proxy bind failed: {e}");
      let _ = state.0.set(0);
      return;
    }
  };
  let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
  let _ = state.0.set(port);
  log::info!("local proxy listening on 127.0.0.1:{port}");

  let client = reqwest::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(15))
    // 不设总超时：SSE 长流合法
    .build()
    .unwrap_or_default();

  loop {
    let Ok((stream, _peer)) = listener.accept().await else {
      continue; // 单连接 accept 失败不杀循环
    };
    let client = client.clone();
    tokio::spawn(async move {
      let io = TokioIo::new(stream);
      let svc = service_fn(move |req| {
        let client = client.clone();
        async move { handle(req, &client).await }
      });
      // 读头大小放宽到 64KB：默认 4KB 对含长 system 提示词的场景够用
      //（提示词走请求体），维持默认即可；连接级错误静默丢弃。
      let _ = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
        .serve_connection(io, svc)
        .await;
    });
  }
}
