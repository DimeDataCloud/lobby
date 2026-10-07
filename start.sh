#!/bin/bash
# Start Lobby (server + client)

echo "🚀 Starting Lobby..."
echo ""

# Start server in background
echo "📦 Starting server on http://localhost:4000"
cd "$(dirname "$0")/apps/server"
bun run src/index.ts &
SERVER_PID=$!

# Wait for server to be ready
sleep 2

# Check if server is running
if curl -s http://localhost:4000/health > /dev/null 2>&1; then
    echo "✅ Server running"
else
    echo "❌ Server failed to start"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

echo ""
echo "🎨 Starting dashboard on http://localhost:5173"
cd "$(dirname "$0")/apps/client"
npm run dev &
CLIENT_PID=$!

# Wait for client to be ready
sleep 3

# Check if client is running
if curl -s http://localhost:5173 > /dev/null 2>&1; then
    echo "✅ Dashboard running"
else
    echo "❌ Dashboard failed to start"
    kill $SERVER_PID $CLIENT_PID 2>/dev/null
    exit 1
fi

echo ""
echo "═══════════════════════════════════════"
echo "  Agent Observability is running!"
echo "═══════════════════════════════════════"
echo ""
echo "  Dashboard: http://localhost:5173"
echo "  Server:    http://localhost:4000"
echo "  WebSocket: ws://localhost:4000/stream"
echo ""
echo "  Press Ctrl+C to stop all services"
echo ""

# Wait for interrupt
trap "kill $SERVER_PID $CLIENT_PID 2>/dev/null; echo ''; echo '👋 Stopped.'; exit 0" INT

# Keep running
wait
