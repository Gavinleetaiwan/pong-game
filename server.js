/**
 * Crowd Interactive Pong Game
 * Experience Collective Intelligence
 *
 * Players join via QR code, get assigned a number:
 * - Even numbers: Defend LEFT paddle
 * - Odd numbers: Defend RIGHT paddle
 *
 * Paddle movement is based on collective votes (up/down ratio)
 * First to 7 points wins
 * Ball speed increases each round
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
const INITIAL_BALL_SPEED = 5;
const SPEED_INCREMENT = 0.5;
const PADDLE_SPEED = 8;
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
    round: 1,
    ballSpeed: INITIAL_BALL_SPEED,
    players: new Map(), // socketId -> { number, team, lastInput, inputTime }
    nextPlayerNumber: 1,
    recentInputs: [], // For marquee display: { number, direction, team, timestamp }
    maxRecentInputs: 20
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
    gameState.round = 1;
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

        // Move paddles based on collective votes
        const leftMove = calculatePaddleMovement(gameState.leftPaddle);
        const rightMove = calculatePaddleMovement(gameState.rightPaddle);

        gameState.leftPaddle.y += leftMove;
        gameState.rightPaddle.y += rightMove;

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
        }

        // Ball collision with right paddle
        if (gameState.ball.x >= CANVAS_WIDTH - PADDLE_WIDTH - 20 - BALL_SIZE &&
            gameState.ball.y + BALL_SIZE >= gameState.rightPaddle.y &&
            gameState.ball.y <= gameState.rightPaddle.y + PADDLE_HEIGHT &&
            gameState.ball.vx > 0) {
            gameState.ball.vx *= -1;
            const hitPos = (gameState.ball.y - gameState.rightPaddle.y) / PADDLE_HEIGHT;
            gameState.ball.vy = (hitPos - 0.5) * gameState.ballSpeed * 2;
        }

        // Score detection
        let scored = false;
        if (gameState.ball.x <= 0) {
            // Right team scores
            gameState.score.right++;
            scored = true;
        } else if (gameState.ball.x >= CANVAS_WIDTH) {
            // Left team scores
            gameState.score.left++;
            scored = true;
        }

        if (scored) {
            gameState.round++;
            gameState.ballSpeed = INITIAL_BALL_SPEED + (gameState.round - 1) * SPEED_INCREMENT;

            // Check for winner
            if (gameState.score.left >= WINNING_SCORE || gameState.score.right >= WINNING_SCORE) {
                gameState.status = 'finished';
                const winner = gameState.score.left >= WINNING_SCORE ? 'left' : 'right';
                io.emit('game:finished', {
                    winner,
                    score: gameState.score
                });
            } else {
                // Reset for next round
                setTimeout(() => {
                    resetRound();
                    io.emit('game:roundStart', {
                        round: gameState.round,
                        score: gameState.score,
                        ballSpeed: gameState.ballSpeed
                    });
                }, 1500);
            }

            io.emit('game:scored', {
                score: gameState.score,
                round: gameState.round
            });
        }

        // Clear votes after processing (votes are per-frame)
        // Actually, keep votes persistent until player changes input

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
            score: gameState.score,
            round: gameState.round,
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

// Confirmation displays for large events
app.get('/display1', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/display2', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
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
        round: gameState.round,
        playerCount: gameState.players.size,
        leftTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'left').length,
        rightTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'right').length
    });
});

// Get all players (for confirmation display)
app.get('/players', (req, res) => {
    const players = Array.from(gameState.players.entries()).map(([id, p]) => ({
        id,
        number: p.number,
        team: p.team,
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
            round: gameState.round,
            playerCount: gameState.players.size,
            leftTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'left').length,
            rightTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'right').length,
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

    // Player joins
    socket.on('player:join', () => {
        // Assign player number
        const playerNumber = gameState.nextPlayerNumber++;
        const team = playerNumber % 2 === 0 ? 'left' : 'right';

        gameState.players.set(socket.id, {
            number: playerNumber,
            team: team,
            lastInput: null,
            inputTime: null
        });

        socket.join('players');
        socket.join(team === 'left' ? 'leftTeam' : 'rightTeam');

        socket.emit('player:assigned', {
            number: playerNumber,
            team: team,
            teamName: team === 'left' ? '左方' : '右方',
            status: gameState.status
        });

        // Notify displays and admin
        io.to('displays').emit('player:joined', {
            number: playerNumber,
            team: team,
            totalPlayers: gameState.players.size
        });

        io.to('admins').emit('admin:playerUpdate', {
            playerCount: gameState.players.size,
            leftTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'left').length,
            rightTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'right').length
        });

        console.log(`Player ${playerNumber} joined (${team} team)`);
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

        // Update vote counts
        const paddle = player.team === 'left' ? gameState.leftPaddle : gameState.rightPaddle;

        // Remove previous vote if exists
        if (prevInput === 'up') paddle.upVotes = Math.max(0, paddle.upVotes - 1);
        if (prevInput === 'down') paddle.downVotes = Math.max(0, paddle.downVotes - 1);

        // Add new vote
        if (direction === 'up') paddle.upVotes++;
        if (direction === 'down') paddle.downVotes++;

        // Add to recent inputs for marquee
        gameState.recentInputs.unshift({
            number: player.number,
            direction: direction,
            team: player.team,
            timestamp: Date.now()
        });

        // Keep only recent inputs
        if (gameState.recentInputs.length > gameState.maxRecentInputs) {
            gameState.recentInputs.pop();
        }

        // Emit to displays for marquee effect
        io.to('displays').emit('input:received', {
            number: player.number,
            direction: direction,
            team: player.team
        });
    });

    // Player releases button
    socket.on('player:release', () => {
        const player = gameState.players.get(socket.id);
        if (!player || !player.lastInput) return;

        const paddle = player.team === 'left' ? gameState.leftPaddle : gameState.rightPaddle;

        // Remove vote
        if (player.lastInput === 'up') paddle.upVotes = Math.max(0, paddle.upVotes - 1);
        if (player.lastInput === 'down') paddle.downVotes = Math.max(0, paddle.downVotes - 1);

        player.lastInput = null;
    });

    // Admin controls
    socket.on('admin:start', () => {
        if (gameState.status === 'waiting' || gameState.status === 'finished') {
            resetGame();
            gameState.status = 'playing';
            startGameLoop();
            io.emit('game:started', {
                round: gameState.round,
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
            // Remove their vote
            const paddle = player.team === 'left' ? gameState.leftPaddle : gameState.rightPaddle;
            if (player.lastInput === 'up') paddle.upVotes = Math.max(0, paddle.upVotes - 1);
            if (player.lastInput === 'down') paddle.downVotes = Math.max(0, paddle.downVotes - 1);

            gameState.players.delete(socket.id);

            io.to('admins').emit('admin:playerUpdate', {
                playerCount: gameState.players.size,
                leftTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'left').length,
                rightTeamCount: Array.from(gameState.players.values()).filter(p => p.team === 'right').length
            });

            console.log(`Player ${player.number} disconnected`);
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
    console.log(`🎮 Admin:      http://localhost:${PORT}/admin`);
    console.log(`📱 Player URL: http://${ip}:${PORT}/play`);
    console.log(`\n🎯 First to ${WINNING_SCORE} points wins!`);
    console.log('='.repeat(50) + '\n');
});
