# scripts/start-bonsai.ps1
# 知览 (KnowView) 本地 Bonsai-27B 启动脚本（8GB 显存优化）

$ErrorActionPreference = "Stop"

$BonsaiDemo = "D:\Application\LocalModel\Bonsai-demo"
if (!(Test-Path "$BonsaiDemo\scripts\start_llama_server.ps1")) {
    Write-Error "未找到官方 Bonsai-demo：$BonsaiDemo"
    exit 1
}

$env:BONSAI_FAMILY = "bonsai"
$env:BONSAI_MODEL  = "27B"
$env:BONSAI_CTX    = "8192"
$env:BONSAI_MMPROJ_CPU = "1"

Push-Location $BonsaiDemo
try {
    & .\scripts\start_llama_server.ps1
} finally {
    Pop-Location
}
