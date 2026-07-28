$port_seed="3005"
$api = 'http://localhost:3001/v1'
$email = "demo+$port_seed@example.com"

$reg = Invoke-RestMethod -Method Post -Uri "$api/auth/register" -ContentType 'application/json' -Body(@{
    email = $email;
    password = 'Password123!';
    tenantName = "Demo Tenant Workspace";
} | ConvertTo-Json)

$token = $reg.accessToken

$site = Invoke-RestMethod -Method Post -Uri "$api/sites" -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $token" } `
    -Body(@{
        name = "Demo Site";
        primaryDomain = "localhost:$port_seed";
    } | ConvertTo-Json)

Invoke-RestMethod -Method Post -Uri "$api/sites/$($site.id)/origins" -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $token" } `
    -Body(@{
        origin = "http://localhost:$port_seed";
    } | ConvertTo-Json)

Write-Host "SITE_ID=$($site.id)"
Write-Host "INGEST_KEY=$($site.ingestKey)"
Write-Host "PUBLIC_KEY=$($site.publicKey)"