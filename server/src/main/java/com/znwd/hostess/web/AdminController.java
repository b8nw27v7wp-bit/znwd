package com.znwd.hostess.web;

import java.util.LinkedHashMap;
import jakarta.servlet.http.HttpServletRequest;

import java.util.List;
import java.util.Map;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.domain.UncoveredEntry;
import com.znwd.hostess.session.SessionStore;

/** 运营管理接口：统计、未覆盖问题清单、反馈汇总（含 CSV 导出）。 */
@RestController
public class AdminController {

    private final Analytics analytics;
    private final SessionStore sessions;
    private final AppProperties props;

    public AdminController(Analytics analytics, SessionStore sessions, AppProperties props) {
        this.analytics = analytics;
        this.sessions = sessions;
        this.props = props;
    }

    @GetMapping("/api/stats")
    public Map<String, Object> stats(
            @RequestHeader(value = "authorization", required = false) String authorization,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        return analytics.stats(sessions.count());
    }

    @GetMapping("/api/admin/uncovered")
    public Map<String, Object> uncovered(
            @RequestHeader(value = "authorization", required = false) String authorization,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        List<UncoveredEntry> items = analytics.uncoveredList(props.uncoveredLogSize());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", items.size());
        out.put("items", items);
        return out;
    }

    @GetMapping("/api/admin/feedback-stats")
    public ResponseEntity<?> feedbackStats(
            @RequestHeader(value = "authorization", required = false) String authorization,
            @RequestParam(value = "format", required = false) String format,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        if ("csv".equalsIgnoreCase(format == null ? "" : format)) {
            String csv = analytics.feedbackCsv();
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "text/csv; charset=utf-8")
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"feedback.csv\"")
                    .body(csv);
        }
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(analytics.feedbackStats());
    }
}
