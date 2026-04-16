(function () {
    'use strict';

    // === НАЛАШТУВАННЯ ===
    var TARGET_MODEL = 'gemini-2.5-flash-lite';
    var STORAGE_KEY = 'google_lite_key_v1';
    
    // ГЛОБАЛЬНА ІСТОРІЯ
    window.plugin_ai_session_ids = window.plugin_ai_session_ids || new Set();

    // === UI ===
    function addIcon(type) {
        var ico = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><circle cx="9" cy="9" r="1"></circle><circle cx="15" cy="15" r="1"></circle><circle cx="15" cy="9" r="1"></circle><circle cx="9" cy="15" r="1"></circle></svg>';
        return '<div class="menu__ico">' + ico + '</div>';
    }

    var statusBox = null;
    function updateStatus(text) {
        if (!statusBox) {
            var html = '<div id="ai-search-status" style="position: fixed; bottom: 80px; left: 0; right: 0; text-align: center; z-index: 10001; pointer-events: none;">' +
                       '<div style="display: inline-block; background: rgba(0,0,0,0.9); padding: 15px 25px; border-radius: 50px; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 5px 20px rgba(0,0,0,0.8); backdrop-filter: blur(10px);">' +
                       '<span class="status-text" style="color: #fff; font-size: 1.2em; font-weight: 500;"></span>' +
                       '</div></div>';
            $('body').append(html);
            statusBox = $('#ai-search-status');
        }
        statusBox.find('.status-text').text(text);
        statusBox.fadeIn(200);
    }
    function hideStatus() { if(statusBox) statusBox.fadeOut(500); }

    // === БЕЗПЕЧНА КАРТКА ===
    var GENRES_MAP = {28:"Бойовик",12:"Пригоди",16:"Мультфільм",35:"Комедія",80:"Кримінал",99:"Документальний",18:"Драма",10751:"Сімейний",14:"Фентезі",36:"Історія",27:"Жахи",10402:"Музика",9648:"Детектив",10749:"Мелодрама",878:"Фантастика",10770:"Телефільм",53:"Трилер",10752:"Військовий",37:"Вестерн"};

    function buildSafeCard(item, type) {
        if (!item || !item.id) return null;
        if (!item.backdrop_path) return null; 

        var card = {
            id: item.id,
            source: 'tmdb',
            // ВИПРАВЛЕННЯ: якщо тип anime, примусово встановлюємо media_type як tv
            media_type: (type === 'cartoon') ? 'movie' : (type === 'anime') ? 'tv' : type,
            ready: true,
            title: String(item.title || item.name || 'Без назви'),
            original_title: String(item.original_title || item.original_name || item.title || item.name || ''),
            overview: String(item.overview || ''),
            release_date: String(item.release_date || item.first_air_date || '2000-01-01'),
            poster_path: item.poster_path,
            backdrop_path: item.backdrop_path,
            vote_average: parseFloat(item.vote_average || 0),
            vote_count: parseInt(item.vote_count || 0),
            genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids : [],
            production_countries: [],
            origin_country: item.origin_country || []
        };

        if (card.genre_ids.length) {
            card.genres = card.genre_ids.map(function(id) { return { id: id, name: GENRES_MAP[id] || 'Жанр' }; });
        } else {
            card.genres = [{ id: 0, name: 'Інше' }];
        }

        if (card.media_type === 'movie') {
            if (!card.origin_country.length && item.original_language) card.origin_country = [item.original_language.toUpperCase()];
            if (!card.origin_country.length) card.origin_country = ['US'];
        }
        
        card.production_countries = card.origin_country.map(function(c) { return { iso_3166_1: c, name: c }; });

        return card;
    }

    // === RANDOM ДЖЕРЕЛО ===
    var NativeRandomSource = {
        list: function(params, oncomplite, onerror) {
            var type = params.url || 'movie'; 
            var minRate = parseFloat(Lampa.Storage.get('ai_min_rating', '6')); 
            var yearLimit = parseInt(Lampa.Storage.get('ai_year_limit', '0'));
            
            if (params.page === 1) {
                window.plugin_ai_session_ids.clear();
                var yearText = '';
                if (yearLimit > 0) {
                    if (yearLimit === 2020) yearText = ' (2020+)';
                    else yearText = ' (' + yearLimit + '-' + (yearLimit + 9) + ')';
                }
                var rateText = minRate > 0 ? ' (Рейтинг > ' + minRate + ')' : '';
                updateStatus('🎲 Шукаю' + yearText + rateText + '...');
            }

            var endpoint = 'movie'; 
            var query = [];

            if (type === 'movie') { endpoint = 'movie'; query.push('without_genres=16'); } 
            else if (type === 'tv') { endpoint = 'tv'; query.push('without_genres=16'); }
            else if (type === 'cartoon') { 
                endpoint = 'movie'; 
                query.push('with_genres=16'); 
            }
            else if (type === 'anime') { 
                endpoint = 'tv'; 
                query.push('with_genres=16'); 
                query.push('with_original_language=ja'); 
            }

            // Фільтр по роках
            if (yearLimit > 0) {
                var dateField = (endpoint === 'movie') ? 'primary_release_date' : 'first_air_date';
                query.push(dateField + '.gte=' + yearLimit + '-01-01');
                if (yearLimit < 2020) {
                    var endYear = yearLimit + 9;
                    query.push(dateField + '.lte=' + endYear + '-12-31');
                }
            }

            // РЕЙТИНГ (ОЦІНКА)
            if (minRate > 0) {
                query.push("vote_average.gte=" + minRate);
                query.push("vote_count.gte=50"); 
            } else {
                 query.push("vote_count.gte=20"); 
            }

            query.push('include_adult=true');

            var baseQuery = "&" + query.join('&');

            var accumulatedCards = [];
            var attempts = 0;
            var MAX_ATTEMPTS = 20;
            var maxPage = 100; 
            
            // Базові ліміти для зменшення кількості пустих запитів
            if (type === 'anime') maxPage = 20; 
            if (yearLimit > 0 && yearLimit < 2020) maxPage = 50; 
            if (yearLimit >= 2020) maxPage = 30; 

            var usedPagesInBatch = []; 

            function fetchBatch() {
                attempts++;
                var randomPage;
                var safeLoop = 0;
                do {
                    randomPage = Math.floor(Math.random() * maxPage) + 1;
                    safeLoop++;
                } while (usedPagesInBatch.indexOf(randomPage) !== -1 && safeLoop < 20);
                usedPagesInBatch.push(randomPage);

                var url = "discover/" + endpoint + "?api_key=" + Lampa.TMDB.key() + 
                          "&language=uk-UA&sort_by=popularity.desc" + 
                          "&page=" + randomPage + baseQuery;

                Lampa.Network.silent(Lampa.TMDB.api(url), function(data) {
                    // Виправлення багу з пустими сторінками (особливо для аніме)
                    if (data && data.total_pages) {
                        var actualMaxPage = Math.min(data.total_pages, 500); // TMDB підтримує максимум 500 сторінок
                        if (actualMaxPage < maxPage) {
                            maxPage = actualMaxPage;
                            if (randomPage > maxPage) {
                                // Якщо згенерована сторінка більша за реально існуючу, пробуємо ще раз
                                return fetchBatch();
                            }
                        }
                    }

                    if (data && data.results) {
                        data.results.forEach(function(item) {
                            if (type === 'cartoon' && item.original_language === 'ja') return;
                            if (window.plugin_ai_session_ids.has(item.id)) return;

                            var card = buildSafeCard(item, type);
                            if (card) {
                                window.plugin_ai_session_ids.add(item.id); 
                                accumulatedCards.push(card);
                            }
                        });
                    }

                    if (accumulatedCards.length >= 20 || attempts >= MAX_ATTEMPTS) {
                        hideStatus();
                        if (accumulatedCards.length === 0) {
                            oncomplite({ results: [], title: params.title, page: params.page, total_pages: 1 }); 
                        } else {
                            oncomplite({
                                results: accumulatedCards,
                                title: params.title,
                                page: params.page,        
                                total_pages: 100 
                            });
                        }
                    } else {
                        updateStatus('🎲 Відсіювання (спроба ' + attempts + '/' + MAX_ATTEMPTS + ')... Знайдено: ' + accumulatedCards.length);
                        fetchBatch();
                    }
                }, function() {
                    hideStatus();
                    oncomplite({ results: accumulatedCards.length ? accumulatedCards : [], title: params.title, page: params.page, total_pages: 1 });
                });
            }

            fetchBatch();
        }
    };
    NativeRandomSource.main = NativeRandomSource.list;
    NativeRandomSource.get = NativeRandomSource.list;

    // === AI SEARCH ДЖЕРЕЛО ===
    function parseJson(text) { 
        try { 
            // Видаляємо можливу Markdown розмітку від Gemini (наприклад ```json ... ```)
            var cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
            var start = cleanText.indexOf('[');
            var end = cleanText.lastIndexOf(']');
            if (start !== -1 && end !== -1) {
                return JSON.parse(cleanText.substring(start, end + 1));
            }
            return JSON.parse(cleanText); 
        } catch (e) { return null; } 
    }

    var AiSearchSource = {
        discovery: function () {
            return {
                title: '✨ AI Пошук',
                search: function (params, done) {
                    var q = decodeURIComponent(params.query || '').trim();
                    var keys = Lampa.Storage.get(STORAGE_KEY, 'AIzaSyC90m2cqTFsLYaCscvOhGzhNyj8ZjRudtM').split(',');
                    var limit = parseInt(Lampa.Storage.get('ai_result_count', '10'));
                    
                    if (!q || !keys[0]) {
                        Lampa.Noty.show('Не задано API ключ Google');
                        return done([]);
                    }
                    
                    updateStatus('🤖 Думаю над запитом "' + q + '"...');
                    var key = keys[0].trim();
                    
                    var prompt = 'Act as a movie expert. Suggest ' + limit + ' distinct movies or TV series based on this request: "' + q + '". ' +
                                 'Context: If the query is vague (e.g. "renovation"), interpret it as a plot topic (home improvement, construction, comedy about repairs), not just a keyword. ' +
                                 'Prioritize popular content. ' +
                                 'Return strictly a JSON array with no markdown: [{"ru":"Ukrainian Title","orig":"Original Title","year":Year}].';
                    
                    fetch('https://generativelanguage.googleapis.com/v1beta/models/' + TARGET_MODEL + ':generateContent?key=' + key, { 
                        method: "POST", headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) 
                    }).then(function(r){ return r.json() }).then(function(d){
                        
                        if (d.error) {
                            updateStatus('🤖 Помилка API: ' + d.error.message);
                            setTimeout(hideStatus, 3000);
                            return done([]);
                        }

                        if (!d.candidates || !d.candidates[0] || !d.candidates[0].content) {
                            updateStatus('🤖 Порожня відповідь від AI');
                            return done([]);
                        }

                        updateStatus('🤖 Відповідь отримано. Читаю...');
                        var list = parseJson(d.candidates[0].content.parts[0].text);
                        
                        if (!list || !Array.isArray(list)) { 
                            updateStatus('🤖 Помилка формату JSON'); 
                            console.log('AI RAW:', d.candidates[0].content.parts[0].text);
                            setTimeout(hideStatus, 2000);
                            return done([]); 
                        }

                        updateStatus('🤖 AI запропонував ' + list.length + ' назв. Шукаємо в TMDB...');
                        
                        var results = [];
                        var queue = list; 
                        var active = 0;
                        var processed = 0;
                        var totalToProcess = queue.length;

                        function next() {
                            if (!queue.length && active === 0) { 
                                hideStatus(); 
                                if (results.length === 0) Lampa.Noty.show('AI щось знайшов, але в TMDB цього немає');
                                done([{ title: 'AI: '+q, results: results, total: results.length }]); 
                                return; 
                            }
                            
                            if (!queue.length || active >= 3) return; 
                            
                            var item = queue.shift();
                            active++;
                            
                            var qTmdb = item.orig || item.original || item.ru;
                            
                            Lampa.Network.silent(Lampa.TMDB.api("search/multi?query=" + encodeURIComponent(qTmdb) + "&api_key=" + Lampa.TMDB.key() + "&language=uk-UA"), function(t) {
                                processed++;
                                updateStatus('🤖 TMDB: ' + results.length + ' знайдено (' + processed + '/' + totalToProcess + ')');
                                
                                if(t.results && t.results[0]) {
                                    var best = t.results[0];
                                    if(best.media_type === 'movie' || best.media_type === 'tv') {
                                        var c = buildSafeCard(best, best.media_type);
                                        if(c) results.push(c);
                                    }
                                }
                                active--; next();
                            }, function(){ 
                                processed++;
                                active--; next(); 
                            });
                        }
                        next();

                    }).catch(function(e){ 
                        updateStatus('🤖 Помилка мережі: ' + e.message);
                        setTimeout(hideStatus, 3000);
                        done([]); 
                    });
                },
                params: { save: true, lazy: true },
                onSelect: function (p, close) { close(); Lampa.Activity.push({ url: p.element.media_type+'/'+p.element.id, component: 'full', id: p.element.id, method: p.element.media_type, card: p.element, source: 'tmdb' }); }
            };
        }
    };

    // === СТАРТ ===
    function startPlugin() {
        window.plugin_ai_search_ready = true;

        Lampa.SettingsApi.addComponent({ component: 'ai_search_cfg', name: 'AI Пошук', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>' });
        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_key_trigger', type: 'trigger' }, field: { name: 'API Ключі (Google)' }, onRender: function(item) {
            var val = Lampa.Storage.get(STORAGE_KEY, '');
            item.find('.settings-param__value').text(val ? 'Встановлено' : 'Немає').css('color', val ? '#4b5':'#f55');
            item.on('hover:enter', function() {
                Lampa.Input.edit({ title: 'Keys', value: val, free: true, nosave: true }, function(v) { 
                    if(v){ Lampa.Storage.set(STORAGE_KEY, v.trim()); item.find('.settings-param__value').text('OK').css('color', '#4b5'); } 
                });
            });
        }});
        
        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_min_rating', type: 'select', values: { '0': 'Будь-який', '5': '> 5', '6': '> 6', '7': '> 7', '8': '> 8' }, default: '6' }, field: { name: 'Мін. рейтинг' } });

        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_result_count', type: 'select', values: { '10': '10', '20': '20', '30': '30', '50': '50' }, default: '10' }, field: { name: 'AI Результатів' } });
        
        Lampa.SettingsApi.addParam({ 
            component: 'ai_search_cfg', 
            param: { 
                name: 'ai_year_limit', 
                type: 'select', 
                values: { 
                    '0': 'Будь-які', 
                    '1980': '80-ті (1980-1989)', 
                    '1990': '90-ті (1990-1999)', 
                    '2000': '2000-ні (2000-2009)', 
                    '2010': '2010-ті (2010-2019)', 
                    '2020': '2020-ті (2020-...)'
                }, 
                default: '0' 
            }, 
            field: { name: 'Десятиліття (для Random)' } 
        });
        
        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_show_btn_movie', type: 'trigger', default: true }, field: { name: 'Фільми' } });
        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_show_btn_tv', type: 'trigger', default: true }, field: { name: 'Серіали' } });
        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_show_btn_cartoon', type: 'trigger', default: true }, field: { name: 'Мультфільми' } });
        Lampa.SettingsApi.addParam({ component: 'ai_search_cfg', param: { name: 'ai_show_btn_anime', type: 'trigger', default: true }, field: { name: 'Аніме' } });

        Lampa.Api.sources.ai_random = NativeRandomSource;
        Lampa.Search.addSource(AiSearchSource.discovery());

        function addButtons() {
            var list = $('.menu .menu__list').eq(0);
            if (!list.length) return setTimeout(addButtons, 500);

            function btn(type, title, key) {
                if (!Lampa.Storage.get(key, true)) return;
                if (list.find('[data-action="ai_'+type+'"]').length) return;
                var el = $('<li class="menu__item selector" data-action="ai_'+type+'">' + addIcon(type) + '<div class="menu__text">'+title+'</div></li>');
                el.on('hover:enter', function() {
                    Lampa.Activity.push({ url: type, title: title, component: 'category_full', source: 'ai_random', page: 1 });
                });
                list.append(el);
            }

            btn('movie', 'Випадкові фільми', 'ai_show_btn_movie');
            btn('tv', 'Випадкові серіали', 'ai_show_btn_tv');
            btn('cartoon', 'Випадкові мультфільми', 'ai_show_btn_cartoon');
            btn('anime', 'Випадкове аніме', 'ai_show_btn_anime');
        }
        addButtons();
        console.log('AI Search: V50.4 (Anime Nav Fix) - UA Patched');
    }

    if (!window.plugin_ai_search_ready) {
        if (window.appready) start
