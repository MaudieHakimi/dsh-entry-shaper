// 同进程测试聚合器：本机（受限沙箱）下 `node --test` 会因为 spawn 而挂住，
// 所以本地用 `node test/run-all.mjs`，CI 里用 `node --test test/`。两者跑同一批用例。
import './shaping.test.mjs'
