class YFSPAnalyzer {
    constructor() {
        this.baseUrl = 'https://www.yfsp.tv';
        this.videoId = 'oQBP0ycKY24';
        this.qualityLevels = ['576P', '720P', '1080P'];
        this.adSelectors = [
            '.ad-container',
            '.advertisement', 
            '[data-ad]',
            '.banner-ad',
            '.video-ad'
        ];
    }

    async analyzePageStructure(page) {
        const analysis = await page.evaluate(() => {
            return {
                title: document.title,
                videoElements: document.querySelectorAll('video').length,
                scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
                qualityButtons: Array.from(document.querySelectorAll('[data-quality], .quality-btn')).map(el => ({
                    text: el.textContent?.trim(),
                    class: el.className,
                    onclick: el.onclick ? el.onclick.toString() : null
                })),
                adElements: Array.from(document.querySelectorAll('.ad, .advertisement, [class*="ad"]')).map(el => ({
                    tag: el.tagName,
                    class: el.className,
                    id: el.id
                }))
            };
        });
        
        return analysis;
    }

    async testQualitySwitching(page, targetQuality = '720P') {
        console.log(`测试清晰度切换至: ${targetQuality}`);
        
        try {
            const qualityButton = await page.$(`[data-quality="${targetQuality}"]`);
            if (!qualityButton) {
                const handle = await page.evaluateHandle((quality) => {
                    const buttons = Array.from(document.querySelectorAll('.quality-btn'));
                    return buttons.find(btn => (btn.textContent || '').trim().includes(quality)) || null;
                }, targetQuality);
                if (handle) {
                    await handle.click();
                } else {
                    throw new Error(`未找到${targetQuality}清晰度按钮`);
                }
            } else {
                await qualityButton.click();
            }
            
            await page.waitForTimeout(2000);
            
            const currentQuality = await page.evaluate(() => {
                const activeQuality = document.querySelector('.quality-btn.active, [data-quality].active');
                return activeQuality ? activeQuality.textContent.trim() : null;
            });
            
            return {
                success: currentQuality === targetQuality,
                targetQuality,
                currentQuality,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    async testAdBlocking(page) {
        console.log('测试广告屏蔽功能');
        
        const adAnalysis = await page.evaluate((selectors) => {
            const results = {};
            let totalAds = 0;
            let hiddenAds = 0;
            
            selectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                const hidden = Array.from(elements).filter(el => 
                    window.getComputedStyle(el).display === 'none' ||
                    window.getComputedStyle(el).visibility === 'hidden'
                ).length;
                
                results[selector] = {
                    total: elements.length,
                    hidden: hidden
                };
                
                totalAds += elements.length;
                hiddenAds += hidden;
            });
            
            return {
                totalAds,
                hiddenAds,
                blockingRate: totalAds > 0 ? (hiddenAds / totalAds * 100).toFixed(2) + '%' : '0%',
                details: results
            };
        }, this.adSelectors);
        
        return adAnalysis;
    }

    async analyzeJavaScriptModules(page) {
        const jsAnalysis = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script[src]'));
            const modules = [];
            
            scripts.forEach(script => {
                const src = script.src;
                if (src.includes('yfsp.tv') && src.includes('.js')) {
                    modules.push({
                        url: src,
                        filename: src.split('/').pop(),
                        size: script.dataset.size || 'unknown',
                        async: script.async,
                        defer: script.defer
                    });
                }
            });
            
            return modules;
        });
        
        return jsAnalysis;
    }

    async performanceTest(page) {
        const metrics = await page.metrics();
        const performance = await page.evaluate(() => {
            return {
                loadTime: performance.timing.loadEventEnd - performance.timing.navigationStart,
                domContentLoaded: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart,
                firstPaint: performance.getEntriesByType('paint').find(entry => entry.name === 'first-paint')?.startTime || 0,
                resources: performance.getEntriesByType('resource').length
            };
        });
        
        return {
            metrics,
            performance,
            timestamp: new Date().toISOString()
        };
    }

    async runFullTestSuite(page) {
        console.log('开始运行完整测试套件...');
        
        const results = {
            pageStructure: await this.analyzePageStructure(page),
            qualitySwitching: {},
            adBlocking: await this.testAdBlocking(page),
            javaScriptModules: await this.analyzeJavaScriptModules(page),
            performance: await this.performanceTest(page),
            timestamp: new Date().toISOString()
        };
        
        for (const quality of this.qualityLevels) {
            results.qualitySwitching[quality] = await this.testQualitySwitching(page, quality);
            await page.waitForTimeout(1000);
        }
        
        return results;
    }

    generateTestReport(results) {
        const report = {
            summary: {
                totalTests: Object.keys(results.qualitySwitching).length + 2,
                passedTests: 0,
                failedTests: 0,
                executionTime: results.timestamp
            },
            findings: {
                qualitySwitching: {
                    supportedLevels: Object.keys(results.qualitySwitching),
                    successRate: this.calculateSuccessRate(results.qualitySwitching)
                },
                adBlocking: {
                    effectiveness: results.adBlocking.blockingRate,
                    totalAdsFound: results.adBlocking.totalAds
                },
                performance: {
                    loadTime: results.performance.performance.loadTime,
                    resourceCount: results.performance.performance.resources
                }
            },
            recommendations: this.generateRecommendations(results)
        };
        
        return report;
    }

    calculateSuccessRate(qualityResults) {
        const results = Object.values(qualityResults);
        const successful = results.filter(r => r.success).length;
        return (successful / results.length * 100).toFixed(2) + '%';
    }

    generateRecommendations(results) {
        const recommendations = [];

        if (parseFloat(results.adBlocking.blockingRate) < 80) {
            recommendations.push('建议增强广告屏蔽效果');
        }
        
        if (results.performance.performance.loadTime > 3000) {
            recommendations.push('页面加载时间较长，建议优化');
        }
        
        const successRate = parseFloat(this.calculateSuccessRate(results.qualitySwitching));
        if (successRate < 90) {
            recommendations.push('清晰度切换成功率较低，需要检查实现');
        }
        
        return recommendations;
    }
}

async function runAnalysis() {
    const analyzer = new YFSPAnalyzer();

    console.log('分析器已初始化，需要配合浏览器自动化工具使用');
    return analyzer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = YFSPAnalyzer;
}

if (typeof window !== 'undefined') {
    window.YFSPAnalyzer = YFSPAnalyzer;
}
