package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// ================= ЮГайл: «мои задачи» + агрегация по периодам/исполнителям =================
// Фикс живой жалобы (2026-09-06): без этого модели приходилось узнавать свой
// id в ЮГайле, вытягивая ДО 200 сырых карточек задач в контекст ради
// ручного поиска — тот же класс проблемы, что уже дважды чинили для
// get_lims_requests (фильтры lab/период, потом group_by вместо сырых
// записей, см. sbe-web/AGENTS.md v0.1.7/v0.1.8). Раздувшийся транскрипт из
// того обходного пути и уронил следующий, уже не связанный запрос 504.

type yougileTaskFields struct {
	ID                 string   `json:"id"`
	Title              string   `json:"title"`
	Timestamp          int64    `json:"timestamp"`
	Completed          bool     `json:"completed"`
	CompletedTimestamp int64    `json:"completedTimestamp"`
	Assigned           []string `json:"assigned"`
}

type yougileUserFields struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// yougileUserIDCache — email (наш пользователь) → id ЮГайла, чтобы не ходить
// в /users на каждый вызов «мои задачи». Живёт, пока жив процесс — id
// пользователя в ЮГайле не меняется в отличие от ключа доступа.
type stringCache struct {
	mu sync.Mutex
	m  map[string]string
}

func (c *stringCache) get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[key]
	return v, ok
}

func (c *stringCache) set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = value
}

var yougileUserIDCache = &stringCache{m: map[string]string{}}

// yougileResolveMyID — id пользователя ЮГайла, чей email (из нашего JWT)
// совпадает с email в /users ЮГайла. Требует, чтобы у пользователя в ЮГайле
// был указан ТОТ ЖЕ email, что и логин (тот же, что мы используем для auth/keys).
func (s *Server) yougileResolveMyID(ctx context.Context, email string) (string, error) {
	if id, ok := yougileUserIDCache.get(email); ok {
		return id, nil
	}
	items, err := s.yougileListContent(ctx, email, "/users")
	if err != nil {
		return "", err
	}
	for _, item := range items {
		var u yougileUserFields
		if err := json.Unmarshal(item, &u); err != nil {
			continue
		}
		if u.Email != "" && strings.EqualFold(u.Email, email) {
			yougileUserIDCache.set(email, u.ID)
			return u.ID, nil
		}
	}
	return "", fmt.Errorf("yougile: пользователь с email %s не найден в списке пользователей ЮГайла", email)
}

func yougileUserNameMap(items []json.RawMessage) map[string]yougileUserFields {
	out := map[string]yougileUserFields{}
	for _, item := range items {
		var u yougileUserFields
		if err := json.Unmarshal(item, &u); err == nil && u.ID != "" {
			out[u.ID] = u
		}
	}
	return out
}

// yougilePeriodKey — день/неделя (с понедельника)/месяц, тот же принцип
// бакетирования, что и у get_lims_requests group_by (lab-service).
func yougilePeriodKey(t time.Time, groupBy string) string {
	switch groupBy {
	case "week":
		weekday := int(t.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		monday := t.AddDate(0, 0, -(weekday - 1))
		return monday.Format("2006-01-02")
	case "month":
		return t.Format("2006-01")
	default:
		return t.Format("2006-01-02")
	}
}

type yougileSeriesPoint struct {
	Period    string `json:"period"`
	Arrived   int    `json:"arrived"`
	Completed int    `json:"completed"`
}

type yougileExecutorStat struct {
	UserID    string `json:"user_id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	Created   int    `json:"created"`
	Completed int    `json:"completed"`
}

// yougileTaskStats — счёт поступивших/завершённых задач по периодам +
// разбивка по исполнителям за диапазон дат. Считает сервер по уже
// полученным (не сырым в контексте модели) данным — как и у ЛИМС, модель
// получает готовые точки, а не сотни карточек для ручного подсчёта.
func (s *Server) yougileTaskStats(ctx context.Context, email, dateFrom, dateTo, groupBy string) (map[string]any, int, error) {
	from, err := time.Parse("2006-01-02", dateFrom)
	if err != nil {
		return nil, 0, fmt.Errorf("date_from должен быть в формате YYYY-MM-DD")
	}
	toDay, err := time.Parse("2006-01-02", dateTo)
	if err != nil {
		return nil, 0, fmt.Errorf("date_to должен быть в формате YYYY-MM-DD")
	}
	to := toDay.Add(24*time.Hour - time.Nanosecond)

	rawTasks, err := s.yougileListTasks(ctx, email, nil)
	if err != nil {
		return nil, 0, err
	}
	rawUsers, err := s.yougileListContent(ctx, email, "/users")
	if err != nil {
		return nil, 0, err
	}
	users := yougileUserNameMap(rawUsers)

	series := map[string]*yougileSeriesPoint{}
	executors := map[string]*yougileExecutorStat{}
	inRange := 0

	seriesFor := func(key string) *yougileSeriesPoint {
		p, ok := series[key]
		if !ok {
			p = &yougileSeriesPoint{Period: key}
			series[key] = p
		}
		return p
	}
	execFor := func(userID string) *yougileExecutorStat {
		e, ok := executors[userID]
		if !ok {
			u := users[userID]
			name := u.Name
			if name == "" {
				name = u.Email
			}
			if name == "" {
				name = userID
			}
			e = &yougileExecutorStat{UserID: userID, Name: name, Email: u.Email}
			executors[userID] = e
		}
		return e
	}

	for _, raw := range rawTasks {
		var t yougileTaskFields
		if err := json.Unmarshal(raw, &t); err != nil {
			continue
		}
		touched := false
		if t.Timestamp > 0 {
			created := time.UnixMilli(t.Timestamp)
			if !created.Before(from) && !created.After(to) {
				seriesFor(yougilePeriodKey(created, groupBy)).Arrived++
				for _, uid := range t.Assigned {
					execFor(uid).Created++
				}
				touched = true
			}
		}
		if t.Completed && t.CompletedTimestamp > 0 {
			completed := time.UnixMilli(t.CompletedTimestamp)
			if !completed.Before(from) && !completed.After(to) {
				seriesFor(yougilePeriodKey(completed, groupBy)).Completed++
				for _, uid := range t.Assigned {
					execFor(uid).Completed++
				}
				touched = true
			}
		}
		if touched {
			inRange++
		}
	}

	seriesOut := make([]*yougileSeriesPoint, 0, len(series))
	for _, p := range series {
		seriesOut = append(seriesOut, p)
	}
	sort.Slice(seriesOut, func(i, j int) bool { return seriesOut[i].Period < seriesOut[j].Period })

	execOut := make([]*yougileExecutorStat, 0, len(executors))
	for _, e := range executors {
		execOut = append(execOut, e)
	}
	sort.Slice(execOut, func(i, j int) bool {
		return (execOut[i].Created + execOut[i].Completed) > (execOut[j].Created + execOut[j].Completed)
	})

	return map[string]any{"series": seriesOut, "by_executor": execOut}, inRange, nil
}

// handleYougileMyID — GET /api/agent/yougile/my-id: id текущего пользователя
// в ЮГайле (для mine=1 на клиенте, если понадобится напрямую).
func (s *Server) handleYougileMyID(w http.ResponseWriter, r *http.Request) {
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	id, err := s.yougileResolveMyID(r.Context(), email)
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// handleYougileTaskStats — GET /api/agent/yougile/task-stats?date_from=&date_to=&group_by=.
func (s *Server) handleYougileTaskStats(w http.ResponseWriter, r *http.Request) {
	dateFrom := r.URL.Query().Get("date_from")
	dateTo := r.URL.Query().Get("date_to")
	groupBy := r.URL.Query().Get("group_by")
	if groupBy != "day" && groupBy != "week" && groupBy != "month" {
		groupBy = "week"
	}
	if dateFrom == "" || dateTo == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "date_from и date_to обязательны (YYYY-MM-DD)"})
		return
	}
	email, _ := r.Context().Value(permEmailCtx{}).(string)
	result, total, err := s.yougileTaskStats(r.Context(), email, dateFrom, dateTo, groupBy)
	if err != nil {
		writeJSON(w, yougileErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	result["total_touched"] = total
	writeJSON(w, http.StatusOK, result)
}
