export function GET() {
  return Response.json({status:'ok',service:'agent-mail'}, {headers:{'Cache-Control':'no-store'}});
}
