/**
 * Crowd Interactive Pong Game
 * Experience Collective Intelligence
 *
 * All players control the same paddle based on ball position:
 * - When ball is on LEFT side (past center), all control LEFT paddle
 * - When ball is on RIGHT side, all control RIGHT paddle
 * Paddle movement is based on collective votes (up/down ratio)
 * First to 7 points wins
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
let PUBLIC_URL = process.env.PUBLIC_URL || null;

// Game Constants
const WINNING_SCORE = 7;
const INITIAL_BALL_SPEED = 3; // Slower ball
const SPEED_INCREMENT = 0; // No speed increase
const PADDLE_SPEED = 6;
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 600;
const PADDLE_HEIGHT = 120;
const PADDLE_WIDTH = 15;
const BALL_SIZE = 15;

// Game State
const gameState = {
    status: 'waiting', // waiting, playing, paused, finished
    ball: {
        x: CANVAS_WIDTH / 2,
        y: CANVAS_HEIGHT / 2,
        vx: INITIAL_BALL_SPEED,
        vy: INITIAL_BALL_SPEED * (Math.random() > 0.5 ? 1 : -1)
    },
    leftPaddle: {
        y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        upVotes: 0,
        downVotes: 0
    },
    rightPaddle: {
        y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        upVotes: 0,
        downVotes: 0
    },
    score: {
        left: 0,
        right: 0
    },
    ballSpeed: INITIAL_BALL_SPEED,
    activePaddle: 'right', // Which paddle all players control (based on ball position)
    players: new Map(), // socketId -> { number, lastInput, inputTime }
    nextPlayerNumber: 1,
    recentInputs: [], // For marquee display: { number, direction, timestamp }
    maxRecentInputs: 30
};

// Get local IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Get public URL
function getPublicURL() {
    if (PUBLIC_URL) return PUBLIC_URL;
    const ip = getLocalIP();
    return `http://${ip}:${PORT}`;
}

// Reset ball to center
function resetBall(direction = 1) {
    gameState.ball = {
        x: CANVAS_WIDTH / 2,
        y: CANVAS_HEIGHT / 2,
        vx: gameState.ballSpeed * direction,
        vy: gameState.ballSpeed * (Math.random() * 2 - 1)
    };
}

// Reset round
function resetRound() {
    gameState.leftPaddle.y = CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2;
    gameState.rightPaddle.y = CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2;
    gameState.leftPaddle.upVotes = 0;
    gameState.leftPaddle.downVotes = 0;
    gameState.rightPaddle.upVotes = 0;
    gameState.rightPaddle.downVotes = 0;

    // Determine which side gets the ball based on who scored
    const lastScorer = gameState.score.left > gameState.score.right ? -1 : 1;
    resetBall(lastScorer);
}

// Reset entire game
function resetGame() {
    gameState.status = 'waiting';
    gameState.score = { left: 0, right: 0 };
    gameState.ballSpeed = INITIAL_BALL_SPEED;
    gameState.recentInputs = [];
    resetRound();
    resetBall(Math.random() > 0.5 ? 1 : -1);
}

// Calculate paddle movement based on votes
function calculatePaddleMovement(paddle) {
    const totalVotes = paddle.upVotes + paddle.downVotes;
    if (totalVotes === 0) return 0;

    const upRatio = paddle.upVotes / totalVotes;
    const downRatio = paddle.downVotes / totalVotes;

    // Move based on dominant direction
    if (upRatio > downRatio) {
        return -PADDLE_SPEED * (upRatio - 0.5) * 2; // Scale movement
    } else if (downRatio > upRatio) {
        return PADDLE_SPEED * (downRatio - 0.5) * 2;
    }
    return 0;
}

// Game loop
let gameLoop = null;

function startGameLoop() {
    if (gameLoop) clearInterval(gameLoop);

    gameLoop = setInterval(() => {
        if (gameState.status !== 'playing') return;

        // Determine which paddle is active based on ball position
        const prevActivePaddle = gameState.activePaddle;
        gameState.activePaddle = gameState.ball.x < CANVAS_WIDTH / 2 ? 'left' : 'right';

        // Notify if active paddle changed
        if (prevActivePaddle !== gameState.activePaddle) {
            io.emit('game:activePaddleChanged', { activePaddle: gameState.activePaddle });
        }

        // Move ONLY the active paddle based on collective votes
        // The inactive paddle slowly returns to center
        if (gameState.activePaddle === 'left') {
            const leftMove = calculatePaddleMovement(gameState.leftPaddle);
            gameState.leftPaddle.y += leftMove;
            // Inactive paddle slowly centers
            const centerY = CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2;
            gameState.rightPaddle.y += (centerY - gameState.rightPaddle.y) * 0.02;
        } else {
            const rightMove = calculatePaddleMovement(gameState.rightPaddle);
            gameState.rightPaddle.y += rightMove;
            // Inactive paddle slowly centers
            const centerY = CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2;
            gameState.leftPaddle.y += (centerY - gameState.leftPaddle.y) * 0.02;
        }

        // Clamp paddles to screen
        gameState.leftPaddle.y = Math.max(0, Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, gameState.leftPaddle.y));
        gameState.rightPaddle.y = Math.max(0, Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, gameState.rightPaddle.y));

        // Move ball
        gameState.ball.x += gameState.ball.vx;
        gameState.ball.y += gameState.ball.vy;

        // Ball collision with top/bottom walls
        if (gameState.ball.y <= 0 || gameState.ball.y >= CANVAS_HEIGHT - BALL_SIZE) {
            gameState.ball.vy *= -1;
            gameState.ball.y = Math.max(0, Math.min(CANVAS_HEIGHT - BALL_SIZE, gameState.ball.y));
        }

        // Ball collision with left paddle
        if (gameState.ball.x <= PADDLE_WIDTH + 20 &&
            gameState.ball.y + BALL_SIZE >= gameState.leftPaddle.y &&
            gameState.ball.y <= gameState.leftPaddle.y + PADDLE_HEIGHT &&
            gameState.ball.vx < 0) {
            gameState.ball.vx *= -1;
            // Add some angle based on where it hit the paddle
            const hitPos = (gameState.ball.y - gameState.leftPaddle.y) / PADDLE_HEIGHT;
            gameState.ball.vy = (hitPos - 0.5) * gameState.ballSpeed * 2;
            // Emit hit event for sound
            io.emit('game:paddleHit', { side: 'left' });
        }

        // Ball collision with right paddle
        if (gameState.ball.x >= CANVAS_WIDTH - PADDLE_WIDTH - 20 - BALL_SIZE &&
            gameState.ball.y + BALL_SIZE >= gameState.rightPaddle.y &&
            gameState.ball.y <= gameState.rightPaddle.y + PADDLE_HEIGHT &&
            gameState.ball.vx > 0) {
            gameState.ball.vx *= -1;
            const hitPos = (gameState.ball.y - gameState.rightPaddle.y) / PADDLE_HEIGHT;
            gameState.ball.vy = (hitPos - 0.5) * gameState.ballSpeed * 2;
            // Emit hit event for sound
            io.emit('game:paddleHit', { side: 'right' });
        }

        // Score detection
        let scored = false;
        let scoringSide = null;
        if (gameState.ball.x <= 0) {
            // Right side scores (ball went through left goal)
            gameState.score.right++;
            scored = true;
            scoringSide = 'right';
        } else if (gameState.ball.x >= CANVAS_WIDTH) {
            // Left side scores (ball went through right goal)
            gameState.score.left++;
            scored = true;
            scoringSide = 'left';
        }

        if (scored) {
            // Check for winner
            if (gameState.score.left >= WINNING_SCORE || gameState.score.right >= WINNING_SCORE) {
                gameState.status = 'finished';
                const winner = gameState.score.left >= WINNING_SCORE ? 'left' : 'right';
                io.emit('game:finished', {
                    winner,
                    score: gameState.score
                });
            } else {
                // Reset for next point
                setTimeout(() => {
                    resetRound();
                }, 1500);
            }

            // Emit goal sound event
            io.emit('game:goal', { side: scoringSide });

            io.emit('game:scored', {
                score: gameState.score
            });
        }

        // Get the active paddle's vote ratios
        const activePaddle = gameState.activePaddle === 'left' ? gameState.leftPaddle : gameState.rightPaddle;
        const activeUpRatio = activePaddle.upVotes / Math.max(1, activePaddle.upVotes + activePaddle.downVotes);
        const activeDownRatio = activePaddle.downVotes / Math.max(1, activePaddle.upVotes + activePaddle.downVotes);

        // Broadcast game state
        io.emit('game:state', {
            ball: gameState.ball,
            leftPaddle: {
                y: gameState.leftPaddle.y,
                upRatio: gameState.leftPaddle.upVotes / Math.max(1, gameState.leftPaddle.upVotes + gameState.leftPaddle.downVotes),
                downRatio: gameState.leftPaddle.downVotes / Math.max(1, gameState.leftPaddle.upVotes + gameState.leftPaddle.downVotes),
                totalVotes: gameState.leftPaddle.upVotes + gameState.leftPaddle.downVotes
            },
            rightPaddle: {
                y: gameState.rightPaddle.y,
                upRatio: gameState.rightPaddle.upVotes / Math.max(1, gameState.rightPaddle.upVotes + gameState.rightPaddle.downVotes),
                downRatio: gameState.rightPaddle.downVotes / Math.max(1, gameState.rightPaddle.upVotes + gameState.rightPaddle.downVotes),
                totalVotes: gameState.rightPaddle.upVotes + gameState.rightPaddle.downVotes
            },
            activePaddle: gameState.activePaddle,
            activeUpRatio,
            activeDownRatio,
            score: gameState.score,
            status: gameState.status,
            recentInputs: gameState.recentInputs
        });

    }, 1000 / 60); // 60 FPS
}

// Auto-detect PUBLIC_URL from request headers
app.use((req, res, next) => {
    if (!PUBLIC_URL && req.headers.host && !req.headers.host.includes('localhost')) {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        PUBLIC_URL = `${protocol}://${req.headers.host}`;
        console.log(`Auto-detected PUBLIC_URL: ${PUBLIC_URL}`);
    }
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
    res.redirect('/display');
});

app.get('/play', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/display', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// Player test page - shows player numbers with colors
app.get('/test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Alias for test page
app.get('/display1', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

app.get('/display2', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// QR Code endpoint
app.get('/qr', async (req, res) => {
    const url = `${getPublicURL()}/play`;
    try {
        const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
        res.json({ qr, url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Game state endpoint
app.get('/state', (req, res) => {
    res.json({
        status: gameState.status,
        score: gameState.score,
        playerCount: gameState.players.size
    });
});

// Get all players (for confirmation display)
app.get('/players', (req, res) => {
    const players = Array.from(gameState.players.entries()).map(([id, p]) => ({
        id,
        number: p.number,
        lastInput: p.lastInput
    }));
    res.json(players);
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Admin joins
    socket.on('admin:join', () => {
        socket.join('admins');
        socket.emit('admin:state', {
            status: gameState.status,
            score: gameState.score,
            playerCount: gameState.players.size,
            qrUrl: `${getPublicURL()}/play`
        });
    });

    // Display joins
    socket.on('display:join', () => {
        socket.join('displays');
        socket.emit('display:init', {
            canvasWidth: CANVAS_WIDTH,
            canvasHeight: CANVAS_HEIGHT,
            paddleWidth: PADDLE_WIDTH,
            paddleHeight: PADDLE_HEIGHT,
            ballSize: BALL_SIZE,
            status: gameState.status,
            score: gameState.score
        });
    });

    // Test display joins
    socket.on('test:join', () => {
        socket.join('tests');
        // Send current players list
        const playerList = Array.from(gameState.players.values()).map(p => ({
            number: p.number,
            lastInput: p.lastInput
        }));
        socket.emit('test:players', playerList);
    });

    // Player joins
    socket.on('player:join', () => {
        // Assign player number
        const playerNumber = gameState.nextPlayerNumber++;

        gameState.players.set(socket.id, {
            number: playerNumber,
            lastInput: null,
            inputTime: null
        });

        socket.join('players');

        socket.emit('player:assigned', {
            number: playerNumber,
            status: gameState.status
        });

        // Notify displays, admin, and test pages
        io.to('displays').emit('player:joined', {
            number: playerNumber,
            totalPlayers: gameState.players.size
        });

        io.to('tests').emit('test:playerJoined', {
            number: playerNumber
        });

        io.to('admins').emit('admin:playerUpdate', {
            playerCount: gameState.players.size
        });

        console.log(`Player ${playerNumber} joined`);
    });

    // Player input (up/down)
    socket.on('player:input', (data) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;

        const direction = data.direction; // 'up' or 'down'
        const prevInput = player.lastInput;

        // Update player's current input
        player.lastInput = direction;
        player.inputTime = Date.now();

        // Update vote counts for BOTH paddles (all players control both)
        // Remove previous vote if exists
        if (prevInput === 'up') {
            gameState.leftPaddle.upVotes = Math.max(0, gameState.leftPaddle.upVotes - 1);
            gameState.rightPaddle.upVotes = Math.max(0, gameState.rightPaddle.upVotes - 1);
        }
        if (prevInput === 'down') {
            gameState.leftPaddle.downVotes = Math.max(0, gameState.leftPaddle.downVotes - 1);
            gameState.rightPaddle.downVotes = Math.max(0, gameState.rightPaddle.downVotes - 1);
        }

        // Add new vote to both paddles
        if (direction === 'up') {
            gameState.leftPaddle.upVotes++;
            gameState.rightPaddle.upVotes++;
        }
        if (direction === 'down') {
            gameState.leftPaddle.downVotes++;
            gameState.rightPaddle.downVotes++;
        }

        // Add to recent inputs for marquee
        gameState.recentInputs.unshift({
            number: player.number,
            direction: direction,
            timestamp: Date.now()
        });

        // Keep only recent inputs
        if (gameState.recentInputs.length > gameState.maxRecentInputs) {
            gameState.recentInputs.pop();
        }

        // Emit to displays for marquee effect
        io.to('displays').emit('input:received', {
            number: player.number,
            direction: direction
        });

        // Emit to test displays for color feedback
        io.to('tests').emit('test:input', {
            number: player.number,
            direction: direction
        });
    });

    // Player releases button
    socket.on('player:release', () => {
        const player = gameState.players.get(socket.id);
        if (!player || !player.lastInput) return;

        const playerNumber = player.number;

        // Remove vote from both paddles
        if (player.lastInput === 'up') {
            gameState.leftPaddle.upVotes = Math.max(0, gameState.leftPaddle.upVotes - 1);
            gameState.rightPaddle.upVotes = Math.max(0, gameState.rightPaddle.upVotes - 1);
        }
        if (player.lastInput === 'down') {
            gameState.leftPaddle.downVotes = Math.max(0, gameState.leftPaddle.downVotes - 1);
            gameState.rightPaddle.downVotes = Math.max(0, gameState.rightPaddle.downVotes - 1);
        }

        player.lastInput = null;

        // Emit to test displays
        io.to('tests').emit('test:release', {
            number: playerNumber
        });
    });

    // Admin controls
    socket.on('admin:start', () => {
        if (gameState.status === 'waiting' || gameState.status === 'finished') {
            resetGame();
            gameState.status = 'playing';
            startGameLoop();
            io.emit('game:started', {
                score: gameState.score
            });
            console.log('Game started!');
        }
    });

    socket.on('admin:pause', () => {
        if (gameState.status === 'playing') {
            gameState.status = 'paused';
            io.emit('game:paused');
            console.log('Game paused');
        }
    });

    socket.on('admin:resume', () => {
        if (gameState.status === 'paused') {
            gameState.status = 'playing';
            io.emit('game:resumed');
            console.log('Game resumed');
        }
    });

    socket.on('admin:reset', () => {
        resetGame();
        io.emit('game:reset');
        console.log('Game reset');
    });

    socket.on('admin:resetPlayers', () => {
        gameState.players.clear();
        gameState.nextPlayerNumber = 1;
        gameState.leftPaddle.upVotes = 0;
        gameState.leftPaddle.downVotes = 0;
        gameState.rightPaddle.upVotes = 0;
        gameState.rightPaddle.downVotes = 0;
        gameState.recentInputs = [];
        io.emit('players:reset');
        io.to('admins').emit('admin:playerUpdate', {
            playerCount: 0,
            leftTeamCount: 0,
            rightTeamCount: 0
        });
        console.log('Players reset');
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            const playerNumber = player.number;

            // Remove their vote from both paddles
            if (player.lastInput === 'up') {
                gameState.leftPaddle.upVotes = Math.max(0, gameState.leftPaddle.upVotes - 1);
                gameState.rightPaddle.upVotes = Math.max(0, gameState.rightPaddle.upVotes - 1);
            }
            if (player.lastInput === 'down') {
                gameState.leftPaddle.downVotes = Math.max(0, gameState.leftPaddle.downVotes - 1);
                gameState.rightPaddle.downVotes = Math.max(0, gameState.rightPaddle.downVotes - 1);
            }

            gameState.players.delete(socket.id);

            io.to('admins').emit('admin:playerUpdate', {
                playerCount: gameState.players.size
            });

            // Notify test displays
            io.to('tests').emit('test:playerLeft', {
                number: playerNumber
            });

            console.log(`Player ${playerNumber} disconnected`);
        }
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('\n' + '='.repeat(50));
    console.log('🏓 Crowd Interactive Pong Game');
    console.log('='.repeat(50));
    console.log(`\n📺 Display:    http://localhost:${PORT}/display`);
    console.log(`🧪 Test:       http://localhost:${PORT}/test`);
    console.log(`🎮 Admin:      http://localhost:${PORT}/admin`);
    console.log(`📱 Player URL: http://${ip}:${PORT}/play`);
    console.log(`\n🎯 First to ${WINNING_SCORE} points wins!`);
    console.log('='.repeat(50) + '\n');
});
