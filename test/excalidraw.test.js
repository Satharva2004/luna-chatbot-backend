// test/excalidraw.test.js
/**
 * Test file for Excalidraw flowchart generation
 * 
 * To run these tests:
 * 1. Ensure server is running: npm run dev
 * 2. Set GROQ_API_KEY in .env
 * 3. Get a valid JWT token from login
 * 4. Run: node test/excalidraw.test.js
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3000/api/gemini';
const JWT_TOKEN = 'YOUR_JWT_TOKEN_HERE'; // Replace with actual token

// Test utilities
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m'
};

function log(color, message) {
    console.log(`${color}${message}${colors.reset}`);
}

async function testHealthCheck() {
    log(colors.blue, '\n🔍 Testing Health Check...');

    try {
        const response = await fetch(`${BASE_URL}/excalidraw/health`);
        const data = await response.json();

        if (data.success && data.status === 'healthy') {
            log(colors.green, '✅ Health check passed');
            log(colors.yellow, `   Groq configured: ${data.groqConfigured}`);
            return true;
        } else {
            log(colors.red, '❌ Health check failed');
            console.log(data);
            return false;
        }
    } catch (error) {
        log(colors.red, `❌ Health check error: ${error.message}`);
        return false;
    }
}

async function testFlowchartDescription() {
    log(colors.blue, '\n🔍 Testing Flowchart Description...');

    try {
        const response = await fetch(`${BASE_URL}/excalidraw/describe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${JWT_TOKEN}`
            },
            body: JSON.stringify({
                prompt: 'Simple user login flow'
            })
        });

        const data = await response.json();

        if (data.success && data.description) {
            log(colors.green, '✅ Description generation passed');
            log(colors.yellow, `   Description length: ${data.description.length} chars`);
            console.log('\n   Preview:');
            console.log('   ' + data.description.substring(0, 200) + '...\n');
            return true;
        } else {
            log(colors.red, '❌ Description generation failed');
            console.log(data);
            return false;
        }
    } catch (error) {
        log(colors.red, `❌ Description error: ${error.message}`);
        return false;
    }
}

async function testFlowchartGeneration() {
    log(colors.blue, '\n🔍 Testing Flowchart Generation...');

    try {
        const response = await fetch(`${BASE_URL}/excalidraw/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${JWT_TOKEN}`
            },
            body: JSON.stringify({
                prompt: 'Simple login flow with username, password, and submit button',
                options: {
                    style: 'minimal',
                    complexity: 'simple'
                }
            })
        });

        const data = await response.json();

        if (data.success && data.data && data.data.elements) {
            log(colors.green, '✅ Flowchart generation passed');
            log(colors.yellow, `   Elements count: ${data.data.elements.length}`);
            log(colors.yellow, `   Generated at: ${data.metadata.generatedAt}`);

            // Validate element structure
            const firstElement = data.data.elements[0];
            if (firstElement && firstElement.id && firstElement.type) {
                log(colors.green, '   ✓ Elements have valid structure');
                log(colors.yellow, `   First element: ${firstElement.type} (id: ${firstElement.id})`);
            }

            return true;
        } else {
            log(colors.red, '❌ Flowchart generation failed');
            console.log(data);
            return false;
        }
    } catch (error) {
        log(colors.red, `❌ Generation error: ${error.message}`);
        return false;
    }
}

async function testComplexFlowchart() {
    log(colors.blue, '\n🔍 Testing Complex Flowchart...');

    try {
        const response = await fetch(`${BASE_URL}/excalidraw/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${JWT_TOKEN}`
            },
            body: JSON.stringify({
                prompt: 'E-commerce checkout process with cart, login check, shipping details, payment, and order confirmation',
                options: {
                    style: 'modern',
                    complexity: 'detailed'
                }
            })
        });

        const data = await response.json();

        if (data.success && data.data && data.data.elements) {
            log(colors.green, '✅ Complex flowchart generation passed');
            log(colors.yellow, `   Elements count: ${data.data.elements.length}`);

            // Count element types
            const elementTypes = {};
            data.data.elements.forEach(el => {
                elementTypes[el.type] = (elementTypes[el.type] || 0) + 1;
            });

            log(colors.yellow, '   Element types:');
            Object.entries(elementTypes).forEach(([type, count]) => {
                console.log(`     - ${type}: ${count}`);
            });

            return true;
        } else {
            log(colors.red, '❌ Complex flowchart generation failed');
            console.log(data);
            return false;
        }
    } catch (error) {
        log(colors.red, `❌ Complex generation error: ${error.message}`);
        return false;
    }
}

async function testErrorHandling() {
    log(colors.blue, '\n🔍 Testing Error Handling...');

    try {
        // Test missing prompt
        const response1 = await fetch(`${BASE_URL}/excalidraw/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${JWT_TOKEN}`
            },
            body: JSON.stringify({})
        });

        const data1 = await response1.json();

        if (!data1.success && data1.error) {
            log(colors.green, '✅ Missing prompt error handled correctly');
        } else {
            log(colors.red, '❌ Missing prompt should return error');
            return false;
        }

        // Test invalid auth
        const response2 = await fetch(`${BASE_URL}/excalidraw/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer invalid_token'
            },
            body: JSON.stringify({
                prompt: 'test'
            })
        });

        if (response2.status === 401) {
            log(colors.green, '✅ Invalid auth handled correctly');
        } else {
            log(colors.yellow, '⚠️  Auth validation might need review');
        }

        return true;
    } catch (error) {
        log(colors.red, `❌ Error handling test failed: ${error.message}`);
        return false;
    }
}

// Run all tests
async function runAllTests() {
    log(colors.blue, '\n' + '='.repeat(50));
    log(colors.blue, '🧪 Excalidraw API Test Suite');
    log(colors.blue, '='.repeat(50));

    if (JWT_TOKEN === 'YOUR_JWT_TOKEN_HERE') {
        log(colors.red, '\n❌ Please set JWT_TOKEN in the test file');
        log(colors.yellow, '   1. Login to get a token');
        log(colors.yellow, '   2. Replace JWT_TOKEN constant in this file');
        log(colors.yellow, '   3. Run tests again\n');
        return;
    }

    const results = {
        healthCheck: await testHealthCheck(),
        description: await testFlowchartDescription(),
        simpleGeneration: await testFlowchartGeneration(),
        complexGeneration: await testComplexFlowchart(),
        errorHandling: await testErrorHandling()
    };

    // Summary
    log(colors.blue, '\n' + '='.repeat(50));
    log(colors.blue, '📊 Test Results Summary');
    log(colors.blue, '='.repeat(50));

    const passed = Object.values(results).filter(r => r).length;
    const total = Object.keys(results).length;

    Object.entries(results).forEach(([test, passed]) => {
        const status = passed ? '✅' : '❌';
        const color = passed ? colors.green : colors.red;
        log(color, `${status} ${test}`);
    });

    log(colors.blue, '\n' + '='.repeat(50));
    const finalColor = passed === total ? colors.green : colors.yellow;
    log(finalColor, `\n🎯 ${passed}/${total} tests passed\n`);
}

// Run tests
runAllTests().catch(error => {
    log(colors.red, `\n❌ Test suite error: ${error.message}`);
    console.error(error);
});
