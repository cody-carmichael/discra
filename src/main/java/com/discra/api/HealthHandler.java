package com.discra.api;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

public class HealthHandler implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse> {
    private static final String VERSION = "0.0.1-tracer";

    @Override
    public APIGatewayV2HTTPResponse handleRequest(APIGatewayV2HTTPEvent event, Context context) {
        String body = String.format(
            "{\"service\":\"discra-api\",\"version\":\"%s\",\"timestamp\":\"%s\"}",
            VERSION, Instant.now().toString());

        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "GET,OPTIONS");
        headers.put("Access-Control-Allow-Headers", "Content-Type");

        System.out.println("{\"event\":\"health_check\",\"version\":\"" + VERSION + "\"}");

        return APIGatewayV2HTTPResponse.builder()
            .withStatusCode(200)
            .withHeaders(headers)
            .withBody(body)
            .build();
    }
}