package com.discra.api;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayV2HTTPResponse;
import java.util.Map;


public class HealthHandler implements RequestHandler<APIGatewayV2HTTPEvent, APIGatewayV2HTTPResponse> {
    @Override
    public APIGatewayV2HTTPResponse handleRequest(APIGatewayV2HTTPEvent event, Context context) {
        System.out.println("HealthHandler invoked"); // basic log
        return APIGatewayV2HTTPResponse.builder()
                .withStatusCode(200)
                .withBody("{\"ok\":true}")
                .withHeaders(Map.of("Content-Type","application/json","Access-Control-Allow-Origin","*"))
                .build();
    }
}
