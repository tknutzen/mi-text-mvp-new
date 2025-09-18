import { NextResponse } from 'next/server';

export async function GET() {
  const hasKey = !!process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const node = process.version;
  return NextResponse.json({ ok: true, hasKey, model, node });
}