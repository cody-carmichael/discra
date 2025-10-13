package com.discra.api;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import java.util.Map;
import java.util.HashMap;

public class VersionHandler implements RequestHandler<Map<String,Object>, Map<String,Object>> {
    @Override
    public Map<String,Object> handleRequest(Map<String,Object> input, Context context) {
        String version = System.getenv().getOrDefault("VERSION", "dev");
        Map<String,Object> resp = new HashMap<>();
        resp.put("statusCode", 200);
        resp.put("headers", Map.of("Content-Type","application/json"));
        resp.put("body", "{\"version\":\"" + version + "\"}");
        return resp;
    }
}
